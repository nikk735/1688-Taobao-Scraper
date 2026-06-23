from __future__ import annotations

import base64
import hashlib
import io
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path


MODEL_NAME = "ViT-B-32"
PRETRAINED_NAME = "laion2b_s34b_b79k"
DEFAULT_BATCH_SIZE = 128
CUDA_BATCH_SIZE = 256
MIN_BATCH_SIZE = 32
MAX_RESULTS = 2000
CACHE_DIR_NAME = ".listing_search_cache"
CACHE_FILE_NAME = "image_search_clip_index.npz"
HF_MODEL_CACHE_GLOB = ".cache/huggingface/hub/models--laion--CLIP-ViT-B-32-laion2B-s34B-b79K/snapshots/*/open_clip_model.safetensors"

_NUMPY = None
_OPEN_CLIP = None
_TORCH = None
_PIL_IMAGE = None


def ensure_numpy():
    global _NUMPY
    if _NUMPY is None:
        import numpy as np

        _NUMPY = np
    return _NUMPY


def ensure_open_clip():
    global _OPEN_CLIP
    if _OPEN_CLIP is None:
        import open_clip

        _OPEN_CLIP = open_clip
    return _OPEN_CLIP


def ensure_torch():
    global _TORCH
    if _TORCH is None:
        import torch

        _TORCH = torch
    return _TORCH


def ensure_pil_image():
    global _PIL_IMAGE
    if _PIL_IMAGE is None:
        from PIL import Image

        _PIL_IMAGE = Image
    return _PIL_IMAGE


class ImageSearchNotReadyError(RuntimeError):
    pass


class ImageIndexBuildCancelled(RuntimeError):
    pass


@dataclass(frozen=True)
class ImageCandidate:
    listing_id: str
    image_path: Path
    relative_path: str
    file_size: int
    file_mtime_ns: int


class ImageSearchIndex:
    def __init__(self, root_dir: Path, app_state) -> None:
        self.root_dir = root_dir
        self.app_state = app_state
        self.cache_dir = self.root_dir / CACHE_DIR_NAME
        self.cache_path = self.cache_dir / CACHE_FILE_NAME
        self.device = "starting"

        self._lock = threading.RLock()
        self._build_thread: threading.Thread | None = None
        self._build_generation = 0
        self._status: dict[str, object] = self._new_status(message="Waiting to build image index.")
        self._model = None
        self._preprocess = None
        self._tokenizer = None
        self._embeddings = None
        self._listing_ids: list[str] = []
        self._id_to_index: dict[str, int] = {}
        self._last_logged_message = ""

    def _new_status(self, *, message: str, error: str = "") -> dict[str, object]:
        return {
            "enabled": True,
            "ready": False,
            "building": False,
            "model_name": MODEL_NAME,
            "pretrained_name": PRETRAINED_NAME,
            "device": self.device,
            "total_images": 0,
            "processed_images": 0,
            "cached_images": 0,
            "stale": False,
            "manual_reindex_required": False,
            "message": message,
            "error": error,
            "updated_at": time.time(),
        }

    def status(self) -> dict[str, object]:
        with self._lock:
            return dict(self._status)

    def invalidate(self, *, message: str = "Image index invalidated.") -> None:
        with self._lock:
            self._build_generation += 1
            self._build_thread = None
            self._embeddings = None
            self._listing_ids = []
            self._id_to_index = {}
            self._status = self._new_status(message=message)

    def mark_stale(self, *, message: str = "New scraped images are available. Click Reindex Images to refresh visual search.") -> None:
        with self._lock:
            self._build_generation += 1
            ready = self._embeddings is not None and bool(self._listing_ids)
            self._build_thread = None
            self._status = {
                **self._status,
                "ready": ready,
                "building": False,
                "stale": True,
                "manual_reindex_required": True,
                "message": message,
                "error": "",
                "updated_at": time.time(),
            }

    def request_rebuild(self) -> dict[str, object]:
        self.invalidate(message="Manual image reindex requested.")
        self.start_build()
        return self.status()

    def start_build(self) -> None:
        with self._lock:
            if self._build_thread and self._build_thread.is_alive():
                return
            generation = self._build_generation
            self._status |= {
                "building": True,
                "ready": False,
                "message": "Starting image index build.",
                "error": "",
                "stale": False,
                "manual_reindex_required": False,
                "updated_at": time.time(),
            }
            self._build_thread = threading.Thread(
                target=self._build_index_worker,
                args=(generation,),
                daemon=True,
                name="ImageSearchIndexBuilder",
            )
            self._build_thread.start()

    def ensure_ready(self) -> None:
        status = self.status()
        if status.get("ready"):
            return
        raise ImageSearchNotReadyError(status.get("message") or "Image index is still building.")

    def _detect_device(self) -> str:
        torch = ensure_torch()
        return "cuda" if torch.cuda.is_available() else "cpu"

    def _current_candidates(self) -> list[ImageCandidate]:
        data = self.app_state.data()
        candidates: list[ImageCandidate] = []

        for row in data.get("rows", []):
            listing_id = str(row.get("id") or "")
            relative_path = str(row.get("image_path") or "")
            if not listing_id or not relative_path:
                continue
            image_path = (self.root_dir / relative_path).resolve()
            if not image_path.is_file() or not image_path.is_relative_to(self.root_dir.resolve()):
                continue
            stat = image_path.stat()
            candidates.append(
                ImageCandidate(
                    listing_id=listing_id,
                    image_path=image_path,
                    relative_path=relative_path,
                    file_size=int(stat.st_size),
                    file_mtime_ns=int(stat.st_mtime_ns),
                )
            )

        return candidates

    def _load_model(self) -> None:
        if self._model is not None and self._preprocess is not None:
            return

        checkpoint_path = self._resolve_local_checkpoint()
        open_clip = ensure_open_clip()

        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        model, _, preprocess = open_clip.create_model_and_transforms(
            MODEL_NAME,
            pretrained=str(checkpoint_path),
            device=self.device,
        )
        self._tokenizer = open_clip.get_tokenizer(MODEL_NAME)
        print(f"[image-index] using local checkpoint {checkpoint_path}", flush=True)
        model.eval()
        self._model = model
        self._preprocess = preprocess
        try:
            torch = ensure_torch()
            if self.device == "cuda":
                torch.backends.cudnn.benchmark = True
                if hasattr(torch, "set_float32_matmul_precision"):
                    torch.set_float32_matmul_precision("high")
        except Exception:
            pass

    def _resolve_local_checkpoint(self) -> Path:
        configured = os.environ.get("LISTING_SEARCH_CLIP_CHECKPOINT", "").strip()
        if configured:
            configured_path = Path(configured).expanduser().resolve()
            if configured_path.is_file():
                return configured_path

        bundled_candidates = sorted(Path.home().glob(HF_MODEL_CACHE_GLOB))
        if bundled_candidates:
            return bundled_candidates[-1]

        raise RuntimeError(
            "Local CLIP checkpoint not found. Expected a cached checkpoint at "
            f"`~/{HF_MODEL_CACHE_GLOB}` or LISTING_SEARCH_CLIP_CHECKPOINT to be set."
        )

    def _update_status(self, **fields: object) -> None:
        with self._lock:
            self._status.update(fields)
            self._status["updated_at"] = time.time()
            message = str(self._status.get("message") or "")
            error = str(self._status.get("error") or "")
        if message and message != self._last_logged_message:
            print(f"[image-index] {message}", flush=True)
            self._last_logged_message = message
        if error:
            print(f"[image-index] ERROR: {error}", flush=True)

    def _set_ready_index(self, listing_ids: list[str], embeddings, *, cached_images: int, message: str) -> None:
        np = ensure_numpy()
        torch = ensure_torch()

        embeddings = np.asarray(embeddings, dtype=np.float16)
        tensor = torch.from_numpy(embeddings).to(self.device)
        with self._lock:
            self._listing_ids = list(listing_ids)
            self._id_to_index = {listing_id: index for index, listing_id in enumerate(self._listing_ids)}
            self._embeddings = tensor
            self._status = {
                **self._status,
                "ready": True,
                "building": False,
                "total_images": len(self._listing_ids),
                "processed_images": len(self._listing_ids),
                "cached_images": cached_images,
                "stale": False,
                "manual_reindex_required": False,
                "message": message,
                "error": "",
                "device": self.device,
                "updated_at": time.time(),
            }

    def _candidate_cache_key(self, candidate: ImageCandidate) -> str:
        digest = hashlib.sha1()
        digest.update(candidate.listing_id.encode("utf-8"))
        digest.update(candidate.relative_path.encode("utf-8"))
        digest.update(str(candidate.file_size).encode("utf-8"))
        digest.update(str(candidate.file_mtime_ns).encode("utf-8"))
        return digest.hexdigest()

    def _try_load_cache(self):
        np = ensure_numpy()

        if not self.cache_path.is_file():
            return None
        try:
            with np.load(self.cache_path, allow_pickle=False) as payload:
                if {"listing_ids", "relative_paths", "file_sizes", "file_mtimes_ns", "embeddings"}.issubset(
                    payload.files
                ):
                    listing_ids = payload["listing_ids"].tolist()
                    relative_paths = payload["relative_paths"].tolist()
                    file_sizes = payload["file_sizes"].tolist()
                    file_mtimes = payload["file_mtimes_ns"].tolist()
                    embeddings = payload["embeddings"]
                    if (
                        not isinstance(listing_ids, list)
                        or not isinstance(relative_paths, list)
                        or embeddings.ndim != 2
                        or len(listing_ids) != len(relative_paths)
                        or len(listing_ids) != len(file_sizes)
                        or len(listing_ids) != len(file_mtimes)
                        or len(listing_ids) != embeddings.shape[0]
                    ):
                        return None
                    return {
                        "format": "incremental",
                        "listing_ids": [str(item) for item in listing_ids],
                        "relative_paths": [str(item) for item in relative_paths],
                        "file_sizes": [int(item) for item in file_sizes],
                        "file_mtimes_ns": [int(item) for item in file_mtimes],
                        "embeddings": embeddings.astype(np.float16, copy=False),
                    }
                if {"listing_ids", "embeddings"}.issubset(payload.files):
                    listing_ids = payload["listing_ids"].tolist()
                    embeddings = payload["embeddings"]
                    if (
                        not isinstance(listing_ids, list)
                        or embeddings.ndim != 2
                        or len(listing_ids) != embeddings.shape[0]
                    ):
                        return None
                    return {
                        "format": "legacy",
                        "listing_ids": [str(item) for item in listing_ids],
                        "embeddings": embeddings.astype(np.float16, copy=False),
                        "cache_mtime_ns": self.cache_path.stat().st_mtime_ns,
                    }
        except Exception:
            return None

    def _save_cache(self, candidates: list[ImageCandidate], embeddings) -> None:
        np = ensure_numpy()

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        np.savez(
            self.cache_path,
            listing_ids=np.asarray([candidate.listing_id for candidate in candidates]),
            relative_paths=np.asarray([candidate.relative_path for candidate in candidates]),
            file_sizes=np.asarray([candidate.file_size for candidate in candidates], dtype=np.int64),
            file_mtimes_ns=np.asarray([candidate.file_mtime_ns for candidate in candidates], dtype=np.int64),
            embeddings=np.asarray(embeddings, dtype=np.float16),
        )

    def _load_cached_embeddings(self, candidates: list[ImageCandidate]):
        cached = self._try_load_cache()
        if cached is None:
            return {}, 0

        embeddings = cached["embeddings"]
        if cached.get("format") == "legacy":
            if len(cached["listing_ids"]) != len(candidates):
                return {}, 0
            if [candidate.listing_id for candidate in candidates] != cached["listing_ids"]:
                return {}, 0
            latest_image_mtime_ns = max((candidate.file_mtime_ns for candidate in candidates), default=0)
            if int(cached.get("cache_mtime_ns", 0)) < latest_image_mtime_ns:
                return {}, 0
            return {
                self._candidate_cache_key(candidate): embeddings[index]
                for index, candidate in enumerate(candidates)
            }, int(len(candidates))

        by_key: dict[str, object] = {}
        for index, listing_id in enumerate(cached["listing_ids"]):
            candidate = ImageCandidate(
                listing_id=listing_id,
                image_path=self.root_dir / cached["relative_paths"][index],
                relative_path=cached["relative_paths"][index],
                file_size=cached["file_sizes"][index],
                file_mtime_ns=cached["file_mtimes_ns"][index],
            )
            by_key[self._candidate_cache_key(candidate)] = embeddings[index]
        return by_key, int(len(by_key))

    def _encode_batch_paths(self, batch_paths: list[Path]):
        np = ensure_numpy()
        torch = ensure_torch()
        Image = ensure_pil_image()

        self._load_model()
        assert self._model is not None
        assert self._preprocess is not None

        images = []
        for path in batch_paths:
            with Image.open(path) as image:
                images.append(self._preprocess(image.convert("RGB")))

        image_tensor = torch.stack(images).to(self.device)
        with torch.inference_mode():
            if self.device == "cuda":
                with torch.autocast(device_type="cuda", dtype=torch.float16):
                    features = self._model.encode_image(image_tensor)
            else:
                features = self._model.encode_image(image_tensor)

        features = torch.nn.functional.normalize(features, dim=-1)
        return features.detach().cpu().to(torch.float16).numpy()

    def _encode_images(self, image_paths: list[Path], generation: int, *, processed_offset: int = 0):
        np = ensure_numpy()
        torch = ensure_torch()

        batches: list[object] = []
        if not image_paths:
            return np.zeros((0, 512), dtype=np.float16)

        batch_size = CUDA_BATCH_SIZE if self.device == "cuda" else DEFAULT_BATCH_SIZE
        batch_size = min(batch_size, len(image_paths))
        start = 0
        while start < len(image_paths):
            if generation != self._build_generation:
                raise ImageIndexBuildCancelled("Image index build was cancelled.")
            current_size = min(batch_size, len(image_paths) - start)
            batch_paths = image_paths[start : start + current_size]
            try:
                batch_result = self._encode_batch_paths(batch_paths)
            except RuntimeError as exc:
                error_text = str(exc).lower()
                if self.device == "cuda" and "out of memory" in error_text and current_size > MIN_BATCH_SIZE:
                    try:
                        torch.cuda.empty_cache()
                    except Exception:
                        pass
                    batch_size = max(MIN_BATCH_SIZE, current_size // 2)
                    self._update_status(message=f"CUDA memory was tight. Retrying with batch size {batch_size}.")
                    continue
                raise

            batches.append(batch_result)
            start += len(batch_paths)
            processed = processed_offset + start
            self._update_status(
                processed_images=min(processed, self._status.get("total_images", processed)),
                message=f"Encoded {processed} of {self._status.get('total_images', len(image_paths))} images on {self.device}.",
            )

        return np.concatenate(batches, axis=0) if batches else np.zeros((0, 512), dtype=np.float16)

    def _build_index_worker(self, generation: int) -> None:
        np = ensure_numpy()
        try:
            self.device = self._detect_device()
            candidates = self._current_candidates()
            self._update_status(
                building=True,
                ready=False,
                total_images=len(candidates),
                processed_images=0,
                cached_images=0,
                device=self.device,
                message="Scanning local images for CLIP indexing.",
                error="",
            )
            cached_embeddings_by_key, cached_entries = self._load_cached_embeddings(candidates)
            reused_embeddings: list[object] = []
            missing_candidates: list[ImageCandidate] = []
            for candidate in candidates:
                cached_embedding = cached_embeddings_by_key.get(self._candidate_cache_key(candidate))
                if cached_embedding is None:
                    missing_candidates.append(candidate)
                else:
                    reused_embeddings.append(cached_embedding)

            reused_count = len(reused_embeddings)
            self._update_status(
                cached_images=reused_count,
                processed_images=reused_count,
                message=(
                    f"Reused {reused_count} cached embeddings, encoding {len(missing_candidates)} new images on {self.device}."
                    if reused_count or missing_candidates
                    else f"Scanning complete on {self.device}."
                ),
            )

            if missing_candidates:
                self._update_status(message=f"Loading CLIP model on {self.device}.")
                self._load_model()
                new_embeddings = self._encode_images(
                    [candidate.image_path for candidate in missing_candidates],
                    generation,
                    processed_offset=reused_count,
                )
            else:
                new_embeddings = np.zeros((0, 512), dtype=np.float16)
            if generation != self._build_generation:
                return

            assembled: list[object] = []
            new_index = 0
            for candidate in candidates:
                cached_embedding = cached_embeddings_by_key.get(self._candidate_cache_key(candidate))
                if cached_embedding is not None:
                    assembled.append(cached_embedding)
                    continue
                assembled.append(new_embeddings[new_index])
                new_index += 1

            embeddings = np.asarray(assembled, dtype=np.float16)
            listing_ids = [candidate.listing_id for candidate in candidates]
            self._save_cache(candidates, embeddings)
            self._set_ready_index(
                listing_ids,
                embeddings,
                cached_images=reused_count,
                message=(
                    f"Updated GPU image index for {len(listing_ids)} images. "
                    f"Reused {reused_count}, encoded {len(missing_candidates)}."
                ),
            )
        except ImageIndexBuildCancelled:
            self._update_status(
                building=False,
                ready=bool(self._embeddings is not None and self._listing_ids),
                stale=True,
                manual_reindex_required=True,
                error="",
                message="Image index paused. Click Reindex Images to refresh visual search.",
            )
        except Exception as exc:  # noqa: BLE001
            self._update_status(
                building=False,
                ready=False,
                error=str(exc),
                message="GPU image indexing failed.",
            )

    def query(
        self,
        image_bytes: bytes,
        *,
        candidate_ids: list[str] | None = None,
        top_k: int = 200,
    ) -> list[dict[str, object]]:
        torch = ensure_torch()
        Image = ensure_pil_image()

        self.ensure_ready()
        self._load_model()
        print(
            f"[image-index] query received top_k={top_k} candidate_ids={'all' if not candidate_ids else len(candidate_ids)}",
            flush=True,
        )
        assert self._embeddings is not None
        assert self._model is not None
        assert self._preprocess is not None

        with Image.open(io.BytesIO(image_bytes)) as image:
            query_tensor = self._preprocess(image.convert("RGB")).unsqueeze(0).to(self.device)

        with torch.inference_mode():
            if self.device == "cuda":
                with torch.autocast(device_type="cuda", dtype=torch.float16):
                    query_features = self._model.encode_image(query_tensor)
            else:
                query_features = self._model.encode_image(query_tensor)

        query_features = torch.nn.functional.normalize(query_features, dim=-1)

        if candidate_ids:
            indices = [self._id_to_index[candidate_id] for candidate_id in candidate_ids if candidate_id in self._id_to_index]
            if not indices or top_k <= 0:
                return []
            index_tensor = torch.tensor(indices, device=self.device, dtype=torch.long)
            candidate_embeddings = self._embeddings.index_select(0, index_tensor)
            scores = torch.matmul(candidate_embeddings, query_features.T).squeeze(1)
            result_count = min(top_k, len(indices), MAX_RESULTS)
            top_scores, top_indices = torch.topk(scores, k=result_count)
            return [
                {
                    "id": self._listing_ids[indices[int(local_index)]],
                    "score": float(score),
                }
                for score, local_index in zip(top_scores.detach().cpu().tolist(), top_indices.detach().cpu().tolist(), strict=False)
            ]

        if top_k <= 0 or not self._listing_ids:
            return []
        scores = torch.matmul(self._embeddings, query_features.T).squeeze(1)
        result_count = min(top_k, len(self._listing_ids), MAX_RESULTS)
        top_scores, top_indices = torch.topk(scores, k=result_count)
        return [
            {
                "id": self._listing_ids[int(index)],
                "score": float(score),
            }
            for score, index in zip(top_scores.detach().cpu().tolist(), top_indices.detach().cpu().tolist(), strict=False)
        ]

    def query_text(
        self,
        text: str,
        *,
        candidate_ids: list[str] | None = None,
        top_k: int = 200,
    ) -> list[dict[str, object]]:
        torch = ensure_torch()

        self.ensure_ready()
        self._load_model()
        query_text = str(text or "").strip()
        if not query_text:
            return []

        print(
            f"[image-index] text query received top_k={top_k} candidate_ids={'all' if not candidate_ids else len(candidate_ids)}",
            flush=True,
        )
        assert self._embeddings is not None
        assert self._model is not None
        assert self._tokenizer is not None

        token_tensor = self._tokenizer([query_text]).to(self.device)
        with torch.inference_mode():
            if self.device == "cuda":
                with torch.autocast(device_type="cuda", dtype=torch.float16):
                    query_features = self._model.encode_text(token_tensor)
            else:
                query_features = self._model.encode_text(token_tensor)
        query_features = torch.nn.functional.normalize(query_features, dim=-1)

        if candidate_ids:
            indices = [self._id_to_index[candidate_id] for candidate_id in candidate_ids if candidate_id in self._id_to_index]
            if not indices or top_k <= 0:
                return []
            index_tensor = torch.tensor(indices, device=self.device, dtype=torch.long)
            candidate_embeddings = self._embeddings.index_select(0, index_tensor)
            scores = torch.matmul(candidate_embeddings, query_features.T).squeeze(1)
            result_count = min(top_k, len(indices), MAX_RESULTS)
            top_scores, top_indices = torch.topk(scores, k=result_count)
            return [
                {
                    "id": self._listing_ids[indices[int(local_index)]],
                    "score": float(score),
                }
                for score, local_index in zip(top_scores.detach().cpu().tolist(), top_indices.detach().cpu().tolist(), strict=False)
            ]

        if top_k <= 0 or not self._listing_ids:
            return []
        scores = torch.matmul(self._embeddings, query_features.T).squeeze(1)
        result_count = min(top_k, len(self._listing_ids), MAX_RESULTS)
        top_scores, top_indices = torch.topk(scores, k=result_count)
        return [
            {
                "id": self._listing_ids[int(index)],
                "score": float(score),
            }
            for score, index in zip(top_scores.detach().cpu().tolist(), top_indices.detach().cpu().tolist(), strict=False)
        ]


def decode_image_payload(payload: str) -> bytes:
    text = str(payload or "")
    if not text:
        raise ValueError("Missing image payload.")
    if text.startswith("data:"):
        try:
            _, encoded = text.split(",", 1)
        except ValueError as exc:  # noqa: PERF203
            raise ValueError("Malformed data URL.") from exc
    else:
        encoded = text
    return base64.b64decode(encoded)
