"""Generate deterministic, synthetic scale fixtures (stdlib only).

Run explicitly with: python3 scripts/generate_scale.py
The original reference context is read-only and copied into the scale dataset.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "fixtures" / "scale"
SEED = 20261028

def read_context():
    return json.loads((ROOT / "fixtures" / "context.json").read_text(encoding="utf-8"))

def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def money(cents: int) -> str:
    return f"{Decimal(cents) / 100:.2f}"

def product_for(i: int) -> dict:
    """A product from a defined engineering attribute matrix, not a random label."""
    family_specs = [
        ("hex_bolt", "FB", ["A2 stainless", "A4 stainless", "zinc plated steel", "high tensile 8.8", "high tensile 10.9"], "pack", [25, 50, 100, 200], "diameter_mm", [4, 5, 6, 8, 10, 12, 16], "length_mm", [10, 12, 16, 20, 25, 30, 35, 40, 50, 60, 80, 100]),
        ("hex_nut", "FN", ["A2 stainless", "A4 stainless", "zinc plated steel", "high tensile 8"], "pack", [50, 100, 200], "thread", ["M4", "M5", "M6", "M8", "M10", "M12", "M16"], "grade", ["standard", "nyloc", "full nut"]),
        ("washer", "FW", ["A2 stainless", "A4 stainless", "zinc plated steel", "black oxide"], "pack", [50, 100, 200], "diameter_mm", [4, 5, 6, 8, 10, 12, 16], "type", ["flat", "penny", "spring"]),
        ("bearing", "BR", ["2RS sealed", "ZZ shielded", "open", "C3 clearance"], "each", [1], "bore_mm", [10, 12, 15, 17, 20, 25, 30, 35], "series", ["6000", "6200", "6300", "6900"]),
        ("o_ring", "OR", ["NBR 70", "NBR 90", "EPDM", "FKM", "silicone"], "each", [1], "id_mm", [5, 8, 10, 12, 15, 20, 25, 30, 40], "section_mm", [1.5, 2, 2.5, 3, 4, 5]),
        ("fitting", "PF", ["brass BSP", "brass NPT", "stainless BSP", "steel JIC"], "each", [1], "thread_size", ["1/8", "1/4", "3/8", "1/2", "3/4", "1"], "connection", ["male", "female", "elbow", "tee"]),
        ("glove", "GL", ["nitrile", "latex", "vinyl", "cut resistant"], "box", [50, 100], "size", ["S", "M", "L", "XL", "XXL"], "colour", ["blue", "black", "white", "orange"]),
        ("hose", "HO", ["PVC", "rubber", "reinforced PVC", "food grade silicone"], "metre", [1], "id_mm", [6, 8, 10, 12, 16, 20, 25], "pressure_bar", [6, 10, 16, 20, 30]),
        ("tape", "TP", ["PTFE", "PVC electrical", "duct", "self-amalgamating"], "roll", [1, 5, 10], "width_mm", [12, 19, 25, 38, 50], "length_m", [10, 20, 25, 33, 50]),
        ("abrasive_disc", "AD", ["aluminium oxide", "zirconia", "ceramic", "silicon carbide"], "each", [1, 10], "diameter_mm", [75, 115, 125, 180, 230], "grit", [24, 40, 60, 80, 120, 240]),
        ("work_glove", "WG", ["leather", "nitrile coated", "PU coated", "thermal"], "pair", [2], "size", ["S", "M", "L", "XL", "XXL"], "coating", ["palm", "full", "none", "foam"]),
        ("cable_tie", "CT", ["nylon natural", "nylon black UV", "stainless steel"], "pack", [50, 100, 500], "length_mm", [100, 150, 200, 250, 300, 370, 450], "width_mm", [2.5, 3.6, 4.8, 7.6]),
    ]
    subtype_names = {
        "hex_bolt": ["full_thread", "part_thread", "flange_head", "socket_head", "carriage", "countersunk", "button_head", "stud", "set_screw", "shoulder", "eye_bolt", "coach_screw", "machine_screw", "self_driller", "roofing", "security", "imperial"],
        "hex_nut": ["standard", "nyloc", "thin", "full_height", "flange", "cap", "coupling", "wing", "castle", "lock", "cage", "weld", "square", "jam", "imperial", "stainless", "high_tensile"],
        "washer": ["flat", "penny", "spring", "tab", "sealing", "repair", "square", "fender", "shoulder", "shim", "wave", "toothed", "star", "bonded", "imperial", "thick", "thin"],
        "bearing": ["deep_groove", "angular_contact", "thrust", "needle", "spherical", "tapered", "self_aligning", "flanged", "cylindrical", "miniature", "track_roller", "insert", "thin_section", "stainless", "high_temp", "precision", "axial"],
        "o_ring": ["standard", "cord", "hydraulic", "food_grade", "high_temp", "vacuum", "metric", "imperial", "large_bore", "small_bore", "chemical", "steam", "potable_water", "fuel", "pneumatic", "static", "dynamic"],
        "fitting": ["straight", "elbow", "tee", "reducer", "coupling", "adapter", "bulkhead", "hose_tail", "compression", "push_in", "quick_release", "swivel", "union", "cross", "blanking", "barbed", "flared"],
        "glove": ["disposable", "chemical", "exam", "food_prep", "cleanroom", "powder_free", "long_cuff", "textured", "heavy_duty", "light_duty", "sterile", "industrial", "medical", "oil_resistant", "thermal", "waterproof", "general_purpose"],
        "hose": ["general_purpose", "air", "water", "fuel", "chemical", "food_grade", "steam", "hydraulic", "suction", "delivery", "braided", "spiral_reinforced", "high_pressure", "low_pressure", "flexible", "anti_static", "translucent"],
        "tape": ["thread_seal", "electrical", "duct", "self_amalgamating", "masking", "double_sided", "anti_slip", "foil", "cloth", "packaging", "high_temp", "insulation", "floor_marking", "barrier", "waterproof", "conductive", "reflective"],
        "abrasive_disc": ["cutting", "grinding", "flap", "fibre", "diamond", "surface_conditioning", "sanding", "polishing", "debur", "stone", "metal", "stainless", "wood", "paint_removal", "ceramic", "concrete", "fine_finish"],
        "work_glove": ["general_handling", "cut_level_a", "cut_level_b", "cut_level_c", "cut_level_d", "cut_level_e", "welding", "riggers", "thermal", "impact", "chemical", "oil_grip", "assembly", "precision", "winter", "waterproof", "disposable_overglove"],
        "cable_tie": ["standard", "releasable", "mountable", "heat_stabilised", "uv_resistant", "stainless", "detectable", "plenum", "marker", "beaded", "push_mount", "screw_mount", "edge_clip", "reusable", "heavy_duty", "miniature", "high_temperature"],
    }
    # 200 named engineering families, each with a distinct 50+ item attribute matrix.
    family_index = i % 200
    spec_index = family_index % len(family_specs)
    spec = family_specs[spec_index]
    base_family, prefix, finishes, unit, packs, attr1, vals1, attr2, vals2 = spec
    family = f"{base_family}_{subtype_names[base_family][family_index // len(family_specs)]}"
    n = i // 200
    a, b, c = n % len(vals1), (n // len(vals1)) % len(vals2), (n // (len(vals1) * len(vals2))) % len(finishes)
    finish, v1, v2, pack = finishes[c], vals1[a], vals2[b], packs[(n // 3) % len(packs)]
    sku = f"{prefix}-{i + 1:05d}-{c + 1:02d}"
    attrs = {attr1: v1, attr2: v2, "material_or_finish": finish, "product_type": family.rsplit("_", 1)[-1]}
    if family in ("hex_bolt", "hex_nut", "washer", "cable_tie", "glove"):
        attrs["pack_size"] = pack
    desc = f"{finish} {family.replace('_', ' ')} {attr1.replace('_', ' ')} {v1} {attr2.replace('_', ' ')} {v2}"
    if unit in ("pack", "box"):
        desc += f", {unit} {pack}"
    cents = 35 + ((i * 7919) % 42000)
    return {"sku": sku, "family": family, "description": desc, "selling_unit": unit,
            "units_per_pack": pack, "price_gbp": money(cents), "active": True, "attributes": attrs}

def generate():
    ctx = read_context(); rng = random.Random(SEED)
    products = [dict(x) for x in ctx["products"]]
    for p in products:
        p["external_id"] = f"pennbridge.product_{p['sku']}"
    used = {p["sku"] for p in products}
    for i in range(9978):
        p = product_for(i)
        if p["sku"] in used:
            raise ValueError(f"SKU collision: {p['sku']}")
        used.add(p["sku"])
        p["external_id"] = f"pennbridge.product_{p['sku']}"
        products.append(p)
    # Keep exact total active/discontinued split, including reference BR-6204-OLD.
    for p in products[22:2021]:
        p["active"] = False
    accounts = [dict(x) for x in ctx["customers"]]
    for acct in accounts:
        acct["external_id"] = f"pennbridge.partner_{acct['id']}"
    cities = [("Reading", "RG"), ("Leeds", "LS"), ("Bristol", "BS"), ("York", "YO"), ("Derby", "DE"), ("Bath", "BA"), ("Exeter", "EX"), ("Glasgow", "G"), ("Cardiff", "CF"), ("Norwich", "NR")]
    for i in range(5, 251):
        city, area = cities[i % len(cities)]
        accounts.append({"id": f"C{i:03d}", "name": f"{['Alder','Brook','Calder','Dunvale','Eastmere','Fairford','Glenwick','Highmere'][i % 8]} {['Engineering','Maintenance','Packaging','Fabrication','Industrial'][i % 5]} {i:03d} Ltd",
                         "approved_senders": [f"orders{i:03d}@account{i:03d}.example"],
                         "addresses": {"MAIN": f"Unit {1 + i % 40}, Synthetic Works, {city}, TEST {area}{1 + i % 9}"},
                         "status": "credit_hold" if i % 37 == 0 else "active", "external_id": f"pennbridge.partner_C{i:03d}"})
    addresses = []
    for acct in accounts:
        for code, value in acct["addresses"].items():
            addresses.append({"id": f"ADDR-{acct['id']}-{code}", "external_id": f"pennbridge.address_{acct['id']}_{code}", "customer_id": acct["id"], "code": code, "address": value})
    # Add supplementary sites only as separate address records. Keep each account's
    # original `addresses` field as supplied; the normalized table carries the extra sites.
    n = 1
    while len(addresses) < 500:
        acct = accounts[4 + ((n - 1) % 246)]
        code = f"SITE{1 + (n - 1) // 246}"
        city, area = cities[(n - 1) % len(cities)]
        addr = f"Unit {1 + n % 30}, Secondary Synthetic Estate, {city}, TEST {area}{1 + n % 9}"
        addresses.append({"id": f"ADDR-{acct['id']}-{code}", "external_id": f"pennbridge.address_{acct['id']}_{code}", "customer_id": acct["id"], "code": code, "address": addr})
        n += 1
    aliases = [dict(x) for x in ctx["aliases"]]
    for i in range(4998):
        acct = accounts[i % len(accounts)]; prod = products[(i * 97 + 21) % len(products)]
        aliases.append({"id": f"ALIAS-{i + 3:05d}", "external_id": f"pennbridge.alias_{i + 3:05d}", "customer_id": acct["id"], "alias": f"{acct['id']}-PART-{i + 1:05d}", "sku": prod["sku"]})
    agreements = [dict(x) for x in ctx["price_agreements"]]
    agreement_products = [p for p in products if p["active"]]
    for i in range(14997):
        # Assign each account a different product in each block; generated account/SKU
        # pairs are unique, so the generated contracts cannot overlap as price tiers.
        acct = accounts[i % len(accounts)]; prod = agreement_products[(i // len(accounts)) % len(agreement_products)]
        start = date(2025, 1, 1) + timedelta(days=(i * 17) % 730)
        end = start + timedelta(days=90 + i % 365)
        agreements.append({"id": f"PRICE-{i + 4:05d}", "external_id": f"pennbridge.price_{i + 4:05d}", "customer_id": acct["id"], "sku": prod["sku"], "unit_price_gbp": money(max(1, int(Decimal(prod["price_gbp"]) * 100 * (85 + i % 31) / 100))),
                           "minimum_quantity": [1, 5, 10, 25][i % 4], "valid_from": start.isoformat(), "valid_to": end.isoformat()})
    history = []
    active_products = [p for p in products if p["active"]]
    start = date(2024, 1, 1)
    for i in range(12000):
        acct = accounts[(i * 7 + 2) % len(accounts)]
        lines = []
        for j in range(8 + (i % 2)):
            prod = active_products[(i * 43 + j * 113) % len(active_products)]
            quantity = 1 + (i * 11 + j * 7) % 25
            lines.append({"sku": prod["sku"], "quantity": str(quantity), "unit": prod["selling_unit"], "unit_price_gbp": prod["price_gbp"]})
        history.append({"id": f"HIST-{i + 1:05d}", "external_id": f"pennbridge.history_{i + 1:05d}", "customer_id": acct["id"], "po_reference": f"SYN-{i + 1:06d}",
                        "ordered_at": (start + timedelta(days=i % 1000)).isoformat(), "status": ["fulfilled", "cancelled", "invoiced"][i % 3], "lines": lines})
    data = {"catalogue.json": products, "accounts.json": accounts, "addresses.json": addresses,
            "aliases.json": aliases, "price_agreements.json": agreements, "history_orders.json": history}
    OUT.mkdir(parents=True, exist_ok=True)
    for name, value in data.items(): write_json(OUT / name, value)
    manifest = {"synthetic": True, "schema_version": 1, "seed": SEED,
                "counts": {"skus": len(products), "active_skus": sum(p["active"] for p in products), "discontinued_skus": sum(not p["active"] for p in products),
                           "accounts": len(accounts), "addresses": len(addresses), "aliases": len(aliases), "price_agreements": len(agreements),
                           "historical_orders": len(history), "historical_order_lines": sum(len(o["lines"]) for o in history)},
                "files": {name: {"sha256": sha256((OUT / name).read_bytes()).hexdigest(), "bytes": (OUT / name).stat().st_size} for name in data}}
    write_json(OUT / "manifest.json", manifest)
    print(json.dumps(manifest["counts"], sort_keys=True))

if __name__ == "__main__":
    generate()
