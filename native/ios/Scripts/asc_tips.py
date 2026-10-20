#!/usr/bin/env python3
"""Trinkgeld-Käufe (Verbrauchsartikel) von Letzte Runde in App Store Connect anlegen bzw. abgleichen:
Name, Beschreibung (de-DE), Preis (Basisland DEU), Verfügbarkeit (nur DEU) und optional Review-Screenshot.

    python3 Scripts/asc_tips.py [review-screenshot.png]

Screenshot im Simulator (Debug-Build): App mit `-showTipSheet YES -tipPreview YES` starten, `xcrun simctl io … screenshot`.
Braucht: pip install pyjwt cryptography requests; Zugang in ~/.appstoreconnect/ (asc.env + private_keys, nie ins Repo).
"""
import hashlib, os, sys, time
import jwt, requests

APP = "6823285737"
TIPS = {  # productId: (Referenzname, Anzeigename, Beschreibung, Preis) – Apple erlaubt keine Emojis, die App macht aus ;) ein 😉
    "de.sgitaize.letzterunde.tip.small": ("Trinkgeld klein", "Eine Spezi", "Danke! Schaltet nichts frei.", "0.99"),
    "de.sgitaize.letzterunde.tip.medium": ("Trinkgeld mittel", "Tagesration Spezi", "Danke! Schaltet nichts frei.", "3.99"),
    "de.sgitaize.letzterunde.tip.large": ("Trinkgeld groß", "Kasten Spezi", "Bei Netto im Angebot? ;)", "9.99"),
}
NOTE = "Freiwilliges Trinkgeld (Verbrauchsartikel), schaltet nichts frei. Startseite unten: „Kauf mir eine Spezi“."

env = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~/.appstoreconnect/asc.env")) if "=" in l)
KID, ISS = env["ASC_KEY_ID"].strip('"'), env["ASC_ISSUER_ID"].strip('"')
PK = open(os.path.expanduser(f"~/.appstoreconnect/private_keys/AuthKey_{KID}.p8")).read()
TOKEN = jwt.encode({"iss": ISS, "iat": int(time.time()), "exp": int(time.time()) + 1200, "aud": "appstoreconnect-v1"},
                   PK, algorithm="ES256", headers={"kid": KID})
H = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
B = "https://api.appstoreconnect.apple.com/"


def call(method, path, body=None):
    r = requests.request(method, B + path, headers=H, json=body)
    if r.status_code not in (200, 201, 204):
        raise SystemExit(f"{method} {path} → {r.status_code}: {r.text[:500]}")
    return r.json() if r.text else {}


def rel(type_, id_):
    return {"data": {"type": type_, "id": id_}}


shot = open(sys.argv[1], "rb").read() if len(sys.argv) > 1 else None
have = {i["attributes"]["productId"]: i["id"] for i in call("GET", f"v1/apps/{APP}/inAppPurchasesV2?limit=50")["data"]}
for pid, (ref, name, desc, price) in TIPS.items():
    iid = have.get(pid)
    if not iid:
        iid = call("POST", "v2/inAppPurchases", {"data": {"type": "inAppPurchases",
              "attributes": {"name": ref, "productId": pid, "inAppPurchaseType": "CONSUMABLE", "reviewNote": NOTE},
              "relationships": {"app": rel("apps", APP)}}})["data"]["id"]
        call("POST", "v1/inAppPurchaseAvailabilities", {"data": {"type": "inAppPurchaseAvailabilities",
             "attributes": {"availableInNewTerritories": False},
             "relationships": {"inAppPurchase": rel("inAppPurchases", iid),
                               "availableTerritories": {"data": [{"type": "territories", "id": "DEU"}]}}}})
    locs = call("GET", f"v2/inAppPurchases/{iid}/inAppPurchaseLocalizations")["data"]
    de = next((l for l in locs if l["attributes"]["locale"] == "de-DE"), None)
    if de:
        call("PATCH", f"v1/inAppPurchaseLocalizations/{de['id']}", {"data": {"type": "inAppPurchaseLocalizations", "id": de["id"],
             "attributes": {"name": name, "description": desc}}})
    else:
        call("POST", "v1/inAppPurchaseLocalizations", {"data": {"type": "inAppPurchaseLocalizations",
             "attributes": {"locale": "de-DE", "name": name, "description": desc},
             "relationships": {"inAppPurchaseV2": rel("inAppPurchases", iid)}}})
    points = call("GET", f"v2/inAppPurchases/{iid}/pricePoints?filter[territory]=DEU&limit=200")["data"]
    pp = next(p for p in points if p["attributes"]["customerPrice"] == price)
    call("POST", "v1/inAppPurchasePriceSchedules", {
        "data": {"type": "inAppPurchasePriceSchedules", "relationships": {
            "inAppPurchase": rel("inAppPurchases", iid), "baseTerritory": rel("territories", "DEU"),
            "manualPrices": {"data": [{"type": "inAppPurchasePrices", "id": "${p0}"}]}}},
        "included": [{"type": "inAppPurchasePrices", "id": "${p0}", "attributes": {"startDate": None},
                      "relationships": {"inAppPurchasePricePoint": rel("inAppPurchasePricePoints", pp["id"])}}]})
    if shot:
        old = call("GET", f"v2/inAppPurchases/{iid}/appStoreReviewScreenshot").get("data")
        if old:
            call("DELETE", f"v1/inAppPurchaseAppStoreReviewScreenshots/{old['id']}")
        res = call("POST", "v1/inAppPurchaseAppStoreReviewScreenshots", {"data": {"type": "inAppPurchaseAppStoreReviewScreenshots",
              "attributes": {"fileName": "tip-sheet.png", "fileSize": len(shot)},
              "relationships": {"inAppPurchaseV2": rel("inAppPurchases", iid)}}})["data"]
        for op in res["attributes"]["uploadOperations"]:
            requests.request(op["method"], op["url"], headers={h["name"]: h["value"] for h in op["requestHeaders"]},
                             data=shot[op["offset"]:op["offset"] + op["length"]]).raise_for_status()
        call("PATCH", f"v1/inAppPurchaseAppStoreReviewScreenshots/{res['id']}", {"data": {"type": "inAppPurchaseAppStoreReviewScreenshots",
             "id": res["id"], "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(shot).hexdigest()}}})
    print(f"{pid}: {name} · {desc} · {price} €" + (" · Screenshot" if shot else ""))
for i in call("GET", f"v1/apps/{APP}/inAppPurchasesV2?limit=50")["data"]:
    print(" ", i["attributes"]["productId"], i["attributes"]["state"])
