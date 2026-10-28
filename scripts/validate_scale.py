"""Validate generated scale fixture shape, references, units and content hashes."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCALE = ROOT / "fixtures" / "scale"
FILES = ("catalogue.json", "accounts.json", "addresses.json", "aliases.json", "price_agreements.json", "history_orders.json")

def load(name):
    return json.loads((SCALE / name).read_text(encoding="utf-8"))

def main():
    manifest = load("manifest.json")
    assert manifest["synthetic"] is True
    assert manifest["schema_version"] == 1
    for name in FILES:
        blob = (SCALE / name).read_bytes()
        assert sha256(blob).hexdigest() == manifest["files"][name]["sha256"], f"hash mismatch: {name}"
        assert len(blob) == manifest["files"][name]["bytes"], f"size mismatch: {name}"
    ctx = json.loads((ROOT / "fixtures" / "context.json").read_text(encoding="utf-8"))
    products, accounts = load("catalogue.json"), load("accounts.json")
    addresses, aliases = load("addresses.json"), load("aliases.json")
    agreements, orders = load("price_agreements.json"), load("history_orders.json")
    counts = manifest["counts"]
    assert len(products) == counts["skus"] == 10000
    assert sum(bool(p["active"]) for p in products) == counts["active_skus"] == 8000
    assert sum(not bool(p["active"]) for p in products) == counts["discontinued_skus"] == 2000
    assert len(accounts) == counts["accounts"] == 250
    assert len(addresses) == counts["addresses"] == 500
    assert len(aliases) == counts["aliases"] == 5000
    assert len(agreements) == counts["price_agreements"] == 15000
    assert len(orders) == counts["historical_orders"] == 12000
    assert sum(len(o["lines"]) for o in orders) == counts["historical_order_lines"]
    assert 95000 <= counts["historical_order_lines"] <= 110000
    sku_map = {p["sku"]: p for p in products}
    account_ids = {a["id"] for a in accounts}
    assert len(sku_map) == len(products) and len(account_ids) == len(accounts)
    assert all({k: p[k] for k in ctx["products"][0]} == next(x for x in ctx["products"] if x["sku"] == p["sku"]) for p in products[:22])
    assert accounts[:4] == ctx["customers"] or all({k: accounts[i][k] for k in ctx["customers"][i]} == ctx["customers"][i] for i in range(4))
    assert aliases[:2] == ctx["aliases"]
    assert agreements[:3] == ctx["price_agreements"]
    assert len({a["id"] for a in addresses}) == len(addresses)
    assert all(a["customer_id"] in account_ids for a in addresses)
    assert all(a["customer_id"] in account_ids and a["sku"] in sku_map for a in aliases)
    for agreement in agreements:
        assert agreement["customer_id"] in account_ids and agreement["sku"] in sku_map
        assert Decimal(agreement["unit_price_gbp"]) >= 0
        assert date.fromisoformat(agreement["valid_from"]) <= date.fromisoformat(agreement["valid_to"])
    for order in orders:
        assert order["customer_id"] in account_ids
        assert order["synthetic"] if "synthetic" in order else True
        for line in order["lines"]:
            p = sku_map[line["sku"]]
            assert line["unit"] == p["selling_unit"]
            assert Decimal(line["quantity"]) > 0 and Decimal(line["unit_price_gbp"]) >= 0
    families = {p["family"] for p in products}
    assert len(families) >= 200
    assert all(isinstance(p["attributes"], dict) and p["family"] and p["description"] for p in products)
    variants = {(p["family"], json.dumps(p["attributes"], sort_keys=True)) for p in products[22:]}
    assert len(variants) == len(products) - 22, "duplicate family/attribute variant"
    assert len({p["external_id"] for p in products}) == len(products)
    assert len({a["external_id"] for a in accounts}) == len(accounts)
    generated_pairs = [(a["customer_id"], a["sku"]) for a in agreements[3:]]
    assert len(set(generated_pairs)) == len(generated_pairs), "generated agreements repeat account/SKU pairs and may overlap"
    print(f"PASS: {len(products)} SKUs ({counts['active_skus']} active/{counts['discontinued_skus']} discontinued), "
          f"{len(accounts)} accounts, {len(addresses)} addresses, {len(aliases)} aliases, "
          f"{len(agreements)} agreements, {len(orders)} historical orders/{counts['historical_order_lines']} lines; hashes and references valid.")

if __name__ == "__main__":
    main()
