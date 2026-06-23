from __future__ import annotations

import csv
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from listing_price_utils import (
    CANONICAL_PRICE_CURRENCY,
    DEFAULT_EXCHANGE_RATE_CACHE_PATH,
    format_price_text,
    load_or_refresh_exchange_rates,
    merge_csv_headers,
    normalize_price_row,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
SKIP_TOP_LEVEL = {".git", ".listing_search_cache", "__pycache__", "src"}
XML_NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
FORMULA_SYMBOL_RE = re.compile(r'SUBSTITUTE\(([^,]+),\"([^\"]+)\",\"\"\)')


def iter_target_files(root_dir: Path) -> tuple[list[Path], list[Path], list[Path]]:
    manifest_files: list[Path] = []
    csv_files: list[Path] = []
    xlsx_files: list[Path] = []

    for entry in sorted(root_dir.iterdir(), key=lambda item: item.name.lower()):
        if entry.name in SKIP_TOP_LEVEL:
            continue
        if entry.is_dir():
            manifest_files.extend(sorted(entry.rglob("manifest.json"), key=lambda path: str(path).lower()))
            csv_files.extend(sorted(entry.rglob("*.csv"), key=lambda path: str(path).lower()))
            xlsx_files.extend(sorted(entry.rglob("*.xlsx"), key=lambda path: str(path).lower()))
            continue
        if entry.name == "manifest.json":
            manifest_files.append(entry)
        elif entry.suffix.lower() == ".csv":
            csv_files.append(entry)
        elif entry.suffix.lower() == ".xlsx":
            xlsx_files.append(entry)

    return manifest_files, csv_files, xlsx_files


def normalize_manifest_file(path: Path, rates: dict[str, object]) -> int:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("rows")
    if not isinstance(rows, list):
        return 0

    normalized_rows = [normalize_price_row(dict(row), rates) for row in rows if isinstance(row, dict)]
    payload["rows"] = normalized_rows
    payload["price_common_currency"] = CANONICAL_PRICE_CURRENCY
    payload["price_exchange_source"] = rates.get("source", "")
    payload["price_exchange_date"] = rates.get("source_date", "")
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(normalized_rows)


def normalize_csv_file(path: Path, rates: dict[str, object]) -> int:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = [normalize_price_row(dict(row), rates) for row in reader]
        fieldnames = merge_csv_headers(reader.fieldnames or [])

    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({header: row.get(header, "") for header in fieldnames})
    return len(rows)


def cell_reference_to_index(reference: str) -> int:
    letters = "".join(ch for ch in reference if ch.isalpha()).upper()
    index = 0
    for char in letters:
        index = (index * 26) + (ord(char) - ord("A") + 1)
    return max(index - 1, 0)


def read_shared_strings(root: ET.Element) -> list[str]:
    values: list[str] = []
    for string_item in root.findall("main:si", XML_NS):
        values.append("".join(node.text or "" for node in string_item.findall(".//main:t", XML_NS)))
    return values


def set_shared_string_text(root: ET.Element, index: int, text: str) -> None:
    items = root.findall("main:si", XML_NS)
    if index >= len(items):
        return
    item = items[index]
    for child in list(item):
        item.remove(child)
    text_node = ET.SubElement(item, f"{{{XML_NS['main']}}}t")
    if text.strip() != text or "  " in text:
        text_node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    text_node.text = text


def read_inline_string(cell: ET.Element) -> str:
    return "".join(node.text or "" for node in cell.findall(".//main:t", XML_NS))


def set_inline_string(cell: ET.Element, text: str) -> None:
    inline = cell.find("main:is", XML_NS)
    if inline is None:
        inline = ET.SubElement(cell, f"{{{XML_NS['main']}}}is")
    for child in list(inline):
        inline.remove(child)
    text_node = ET.SubElement(inline, f"{{{XML_NS['main']}}}t")
    if text.strip() != text or "  " in text:
        text_node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    text_node.text = text


def normalize_xlsx_file(path: Path, rates: dict[str, object]) -> int:
    with ZipFile(path) as workbook:
        names = workbook.namelist()
        if "xl/sharedStrings.xml" not in names:
            return 0
        sheet_paths = sorted(name for name in names if name.startswith("xl/worksheets/") and name.endswith(".xml"))
        if not sheet_paths:
            return 0
        sheet_path = sheet_paths[0]
        shared_root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
        sheet_root = ET.fromstring(workbook.read(sheet_path))
        shared_strings = read_shared_strings(shared_root)
        original_entries = {name: workbook.read(name) for name in names}

    rows = sheet_root.findall(".//main:sheetData/main:row", XML_NS)
    if not rows:
        return 0

    header_map: dict[int, str] = {}
    for cell in rows[0].findall("main:c", XML_NS):
        if cell.attrib.get("t") != "s":
            continue
        shared_index = int(cell.findtext("main:v", default="0", namespaces=XML_NS))
        header_map[cell_reference_to_index(cell.attrib.get("r", ""))] = shared_strings[shared_index]

    price_column = next((index for index, name in header_map.items() if str(name).strip().lower() == "price"), None)
    normalized_price_column = next(
        (index for index, name in header_map.items() if str(name).strip().lower() == "price normalized"),
        None,
    )
    if price_column is None:
        return 0

    normalized_rows = 0
    for row in rows[1:]:
        cells_by_index = {
            cell_reference_to_index(cell.attrib.get("r", "")): cell for cell in row.findall("main:c", XML_NS)
        }
        price_cell = cells_by_index.get(price_column)
        if price_cell is None:
            continue

        cell_type = price_cell.attrib.get("t")
        original_text = ""
        if cell_type == "s":
            shared_index = int(price_cell.findtext("main:v", default="0", namespaces=XML_NS))
            original_text = shared_strings[shared_index]
        elif cell_type == "inlineStr":
            original_text = read_inline_string(price_cell)
        else:
            original_text = price_cell.findtext("main:v", default="", namespaces=XML_NS)

        normalized_payload = normalize_price_row({"price": original_text}, rates)
        normalized_text = str(normalized_payload.get("price") or "")
        normalized_value = normalized_payload.get("price_value")

        if cell_type == "s":
            shared_index = int(price_cell.findtext("main:v", default="0", namespaces=XML_NS))
            if normalized_text and normalized_text != original_text:
                shared_strings[shared_index] = normalized_text
                set_shared_string_text(shared_root, shared_index, normalized_text)
        elif cell_type == "inlineStr":
            if normalized_text and normalized_text != original_text:
                set_inline_string(price_cell, normalized_text)

        normalized_value_cell = cells_by_index.get(normalized_price_column) if normalized_price_column is not None else None
        if normalized_value_cell is not None and normalized_value is not None:
            value_node = normalized_value_cell.find("main:v", XML_NS)
            if value_node is None:
                value_node = ET.SubElement(normalized_value_cell, f"{{{XML_NS['main']}}}v")
            value_node.text = str(normalized_value)

        normalized_rows += 1

    canonical_prefix = format_price_text(0, CANONICAL_PRICE_CURRENCY).replace("0.00", "")
    for formula in sheet_root.findall(".//main:f", XML_NS):
        if not formula.text or "SUBSTITUTE(" not in formula.text.upper():
            continue
        formula.text = FORMULA_SYMBOL_RE.sub(lambda match: f'SUBSTITUTE({match.group(1)},"{canonical_prefix}","")', formula.text)

    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    with ZipFile(temp_path, "w", compression=ZIP_DEFLATED) as updated:
        for name, payload in original_entries.items():
            if name == "xl/sharedStrings.xml":
                updated.writestr(name, ET.tostring(shared_root, encoding="utf-8", xml_declaration=True))
            elif name == sheet_path:
                updated.writestr(name, ET.tostring(sheet_root, encoding="utf-8", xml_declaration=True))
            else:
                updated.writestr(name, payload)
    temp_path.replace(path)
    return normalized_rows


def main() -> None:
    rates = load_or_refresh_exchange_rates(DEFAULT_EXCHANGE_RATE_CACHE_PATH)
    manifest_files, csv_files, xlsx_files = iter_target_files(ROOT_DIR)

    manifest_rows = 0
    csv_rows = 0
    xlsx_rows = 0

    for path in manifest_files:
        manifest_rows += normalize_manifest_file(path, rates)
    for path in csv_files:
        csv_rows += normalize_csv_file(path, rates)
    for path in xlsx_files:
        xlsx_rows += normalize_xlsx_file(path, rates)

    print(
        (
            f"Normalized {manifest_rows} manifest rows across {len(manifest_files)} manifest files and "
            f"{csv_rows} CSV rows across {len(csv_files)} CSV files and "
            f"{xlsx_rows} XLSX price cells across {len(xlsx_files)} XLSX files into {CANONICAL_PRICE_CURRENCY.upper()} "
            f"using {rates.get('source')} {rates.get('source_date')}."
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Price normalization failed: {exc}", file=sys.stderr, flush=True)
        raise
