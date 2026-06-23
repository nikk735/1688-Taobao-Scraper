import json
import csv
from pathlib import Path
import re

def fix_price(text: str) -> str:
    # "￥150.00" -> "￥1.50"
    if not text:
        return text
    match = re.search(r"^(\D*)([\d.]+)(.*)$", text)
    if not match:
        return text
    prefix = match.group(1)
    val = float(match.group(2)) / 100
    suffix = match.group(3)
    return f"{prefix}{val:.2f}{suffix}"

def process_dir(d: Path):
    manifest_path = d / "manifest.json"
    if manifest_path.exists():
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        rows = data.get("rows", [])
        for r in rows:
            r["price"] = fix_price(r["price"])
            if r.get("price_value"): r["price_value"] = float(r["price_value"]) / 100
            r["price_original"] = fix_price(r["price_original"])
            if r.get("price_original_value"): r["price_original_value"] = float(r["price_original_value"]) / 100
        manifest_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Fixed {len(rows)} rows in {d.name}/{manifest_path.name}")
    
    for csv_path in d.glob("*.csv"):
        with open(csv_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            rows = list(reader)
        
        for r in rows:
            r["price"] = fix_price(r["price"])
            if r.get("price_value"): r["price_value"] = str(float(r["price_value"]) / 100)
            r["price_original"] = fix_price(r["price_original"])
            if r.get("price_original_value"): r["price_original_value"] = str(float(r["price_original_value"]) / 100)
            
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"Fixed {len(rows)} rows in {d.name}/{csv_path.name}")

root = Path(r"c:\Users\nikka\Desktop\ideas\1688scraper\scraped data")
targets = [
    root / "Shenzhen Shuoxin Electronics Co., Ltd",
    root / "Shenzhen Jiewite Technology Co., Ltd"
]

for t in targets:
    if t.exists():
        process_dir(t)
    else:
        print("Not found:", t)
