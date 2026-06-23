const IMAGE_HASH_WIDTH = 9;
const IMAGE_HASH_HEIGHT = 8;
const IMAGE_HISTOGRAM_SIZE = 16;
const IMAGE_SAMPLE_SIZE = 32;

function readDimensions(imageSource) {
  return {
    width: imageSource.width || imageSource.naturalWidth || 1,
    height: imageSource.height || imageSource.naturalHeight || 1,
  };
}

async function sourceToBlob(source) {
  if (source.file instanceof Blob) {
    return source.file;
  }

  const response = await fetch(source.src, {
    cache: "force-cache",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Image request failed with ${response.status}`);
  }
  return response.blob();
}

async function decodeImage(source) {
  const blob = await sourceToBlob(source);
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }

  throw new Error("createImageBitmap is not available in this browser worker.");
}

function renderPixels(imageSource, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
    desynchronized: true,
  });
  context.drawImage(imageSource, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

async function computeImageSignature(source) {
  const decoded = await decodeImage(source);
  try {
    const dimensions = readDimensions(decoded);
    const hashPixels = renderPixels(decoded, IMAGE_HASH_WIDTH, IMAGE_HASH_HEIGHT);
    const histogramPixels = renderPixels(decoded, IMAGE_SAMPLE_SIZE, IMAGE_SAMPLE_SIZE);

    const hash = new Uint8Array(8);
    let bitIndex = 0;
    for (let y = 0; y < IMAGE_HASH_HEIGHT; y += 1) {
      for (let x = 0; x < IMAGE_HASH_WIDTH - 1; x += 1) {
        const leftOffset = (y * IMAGE_HASH_WIDTH + x) * 4;
        const rightOffset = leftOffset + 4;
        const leftLuma =
          hashPixels[leftOffset] * 0.299 +
          hashPixels[leftOffset + 1] * 0.587 +
          hashPixels[leftOffset + 2] * 0.114;
        const rightLuma =
          hashPixels[rightOffset] * 0.299 +
          hashPixels[rightOffset + 1] * 0.587 +
          hashPixels[rightOffset + 2] * 0.114;
        if (leftLuma > rightLuma) {
          hash[bitIndex >> 3] |= 1 << (bitIndex & 7);
        }
        bitIndex += 1;
      }
    }

    const histogram = new Float32Array(IMAGE_HISTOGRAM_SIZE);
    const totalPixels = IMAGE_SAMPLE_SIZE * IMAGE_SAMPLE_SIZE;
    for (let offset = 0; offset < histogramPixels.length; offset += 4) {
      const luma =
        histogramPixels[offset] * 0.299 +
        histogramPixels[offset + 1] * 0.587 +
        histogramPixels[offset + 2] * 0.114;
      const bucket = Math.min(IMAGE_HISTOGRAM_SIZE - 1, Math.floor((luma / 256) * IMAGE_HISTOGRAM_SIZE));
      histogram[bucket] += 1 / totalPixels;
    }

    return {
      hash,
      histogram,
      aspectRatio: dimensions.width > 0 && dimensions.height > 0 ? dimensions.width / dimensions.height : 1,
    };
  } finally {
    decoded.close?.();
  }
}

self.onmessage = async (event) => {
  const { taskId, source } = event.data || {};
  try {
    const signature = await computeImageSignature(source || {});
    self.postMessage(
      {
        taskId,
        ok: true,
        signature,
      },
      [signature.hash.buffer, signature.histogram.buffer]
    );
  } catch (error) {
    self.postMessage({
      taskId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
