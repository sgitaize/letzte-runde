#!/usr/bin/env python3
"""Neue iOS-Version in App Store Connect anlegen und zur Prüfung einreichen (mit noch nicht geprüften Trinkgeld-Käufen).

    python3 Scripts/asc_submit.py <version> <build> [--submit]

- legt die App-Store-Version an (falls nötig), Veröffentlichung manuell
- setzt „Neu in dieser Version“ aus docs/store/metadata/whatsnew-<version>.txt (de-DE) bzw. whatsnew-<version>.<locale>.txt
- bricht ab, wenn die App nicht in den USA angeboten wird: App Review prüft mit einem US-Konto, StoreKit liefert dort
  sonst keine Käufe (zweimal abgelehnt, 2.1(b), Okt. 2026)
- wartet, bis der Build verarbeitet ist, und ordnet ihn zu
- mit --submit: Käufe im Status READY_TO_SUBMIT mit einreichen, Version zur Prüfung schicken
Zugang wie asc_metadata.py (~/.appstoreconnect/, nie ins Repo).
"""
import os, pathlib, sys, time
import jwt, requests

ROOT = pathlib.Path(__file__).resolve().parents[3]
APP = "6823285737"
VERSION, BUILD = sys.argv[1], sys.argv[2]
SUBMIT = "--submit" in sys.argv

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
        raise SystemExit(f"{method} {path} → {r.status_code}: {r.text[:600]}")
    return r.json() if r.text else {}


def rel(type_, id_):
    return {"data": {"type": type_, "id": id_}}


versions = call("GET", f"v1/apps/{APP}/appStoreVersions?filter[platform]=IOS&limit=10")["data"]
v = next((x for x in versions if x["attributes"]["versionString"] == VERSION), None)
if not v:
    v = call("POST", "v1/appStoreVersions", {"data": {"type": "appStoreVersions",
             "attributes": {"platform": "IOS", "versionString": VERSION, "releaseType": "MANUAL"},
             "relationships": {"app": rel("apps", APP)}}})["data"]
    print("Version angelegt", VERSION)
vid = v["id"]
print("Version", VERSION, v["attributes"].get("appStoreState"))

META = ROOT / "docs/store/metadata"
for l in call("GET", f"v1/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]:
    loc = l["attributes"]["locale"]
    f = META / f"whatsnew-{VERSION}.{loc}.txt"
    if not f.exists(): f = META / f"whatsnew-{VERSION}.txt"
    call("PATCH", f"v1/appStoreVersionLocalizations/{l['id']}", {"data": {"type": "appStoreVersionLocalizations",
         "id": l["id"], "attributes": {"whatsNew": f.read_text().strip()}}})
    print("Neu in dieser Version:", loc, "←", f.name)

for _ in range(60):
    builds = call("GET", f"v1/builds?filter[app]={APP}&filter[version]={BUILD}&filter[preReleaseVersion.version]={VERSION}")["data"]
    if builds and builds[0]["attributes"]["processingState"] == "VALID":
        break
    print("warte auf Build", BUILD, builds[0]["attributes"]["processingState"] if builds else "(noch nicht da)")
    time.sleep(30)
else:
    raise SystemExit("Build nicht verarbeitet")
call("PATCH", f"v1/appStoreVersions/{vid}/relationships/build", {"data": {"type": "builds", "id": builds[0]["id"]}})
print("Build", BUILD, "zugeordnet")

if not SUBMIT:
    raise SystemExit("fertig vorbereitet (ohne --submit nicht eingereicht)")

pending = [i for i in call("GET", f"v1/apps/{APP}/inAppPurchasesV2?limit=50")["data"] if i["attributes"]["state"] == "READY_TO_SUBMIT"]
if pending and "--iaps-selected" not in sys.argv:
    # Die ersten Verbrauchsartikel einer App müssen zusammen mit einer Version eingereicht werden
    # (STATE_ERROR.FIRST_CONSUMABLE_MUST_BE_SUBMITTED_ON_VERSION) – diese Auswahl gibt es nur in der Weboberfläche.
    raise SystemExit("Noch nicht geprüfte Käufe: " + ", ".join(i["attributes"]["productId"] for i in pending) +
                     "\n→ In App Store Connect bei der Version unter „In-App-Käufe und Abonnements“ auswählen und dort "
                     "„Zur Prüfung hinzufügen“ – oder danach erneut mit --iaps-selected aufrufen.")

av = call("GET", f"v1/apps/{APP}/appAvailabilityV2")["data"]
usa = None
url = f"v2/appAvailabilities/{av['id']}/territoryAvailabilities?limit=200&include=territory"
while url and usa is None:
    page = call("GET", url)
    usa = next((t for t in page["data"] if t["relationships"]["territory"]["data"]["id"] == "USA"), None)
    url = (page.get("links", {}).get("next") or "").replace(B, "") or None
if not usa or not usa["attributes"].get("available"):
    raise SystemExit("App ist in den USA nicht verfügbar → App Review (US-Konto) bekommt keine Käufe. "
                     "Erst die Verfügbarkeit erweitern (App Store Connect → Preise und Verfügbarkeit).")

sub = call("POST", "v1/reviewSubmissions", {"data": {"type": "reviewSubmissions", "attributes": {"platform": "IOS"},
           "relationships": {"app": rel("apps", APP)}}})["data"]
call("POST", "v1/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems",
     "relationships": {"reviewSubmission": rel("reviewSubmissions", sub["id"]), "appStoreVersion": rel("appStoreVersions", vid)}}})
call("PATCH", f"v1/reviewSubmissions/{sub['id']}", {"data": {"type": "reviewSubmissions", "id": sub["id"], "attributes": {"submitted": True}}})
print("eingereicht:", VERSION, "Build", BUILD)
