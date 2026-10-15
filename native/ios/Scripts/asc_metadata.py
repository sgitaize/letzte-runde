#!/usr/bin/env python3
"""Uploads store texts and screenshots to App Store Connect (API).

Usage:
  python3 Scripts/asc_metadata.py [--no-screenshots]
  (IDs from ASC_KEY_ID / ASC_ISSUER_ID or ~/.appstoreconnect/asc.env)

The private key is read from ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8
(never commit it). Texts come from docs/store/metadata/*.json, screenshots from
docs/store/screenshots/{iphone,ipad}/*.png (docs/store/storeshots.js). Needs: pip install pyjwt cryptography requests.
Not covered by the API (set by hand in App Store Connect): App Privacy, pricing and
availability, age rating questionnaire.
"""
import hashlib, json, os, pathlib, sys, time

import jwt, requests

ROOT = pathlib.Path(__file__).resolve().parents[3]
META = ROOT / "docs/store/metadata"
STORE = ROOT / "docs/store"
API = "https://api.appstoreconnect.apple.com/v1"


def load_ids():
    """Key and issuer ID from the environment or ~/.appstoreconnect/asc.env (outside git)."""
    env = pathlib.Path.home() / ".appstoreconnect/asc.env"
    if env.exists():
        for line in env.read_text().splitlines():
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())
    return os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"]


def token():
    key_id, issuer = load_ids()
    key = (pathlib.Path.home() / f".appstoreconnect/private_keys/AuthKey_{key_id}.p8").read_text()
    now = int(time.time())
    return jwt.encode({"iss": issuer, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
                      key, algorithm="ES256", headers={"kid": key_id, "typ": "JWT"})


S = requests.Session()


def call(method, path, body=None, **params):
    S.headers["Authorization"] = f"Bearer {token()}"
    r = S.request(method, path if path.startswith("http") else API + path, json=body, params=params or None)
    if r.status_code >= 400:
        sys.exit(f"{method} {path}: {r.status_code} {r.text[:800]}")
    return r.json() if r.text else {}


def rel(type_, id_):
    return {"data": {"type": type_, "id": id_}}


def main():
    app_meta = json.loads((META / "app.json").read_text())
    review = json.loads((META / "review.json").read_text())
    locales = [json.loads(f.read_text()) for f in sorted(META.glob("??-??.json"))]
    with_screens = "--no-screenshots" not in sys.argv

    app = call("GET", "/apps", **{"filter[bundleId]": app_meta["bundleId"]})["data"][0]
    app_id = app["id"]
    print("app", app_id, app["attributes"]["name"])

    # App info (name, subtitle, privacy URL per locale; category)
    infos = call("GET", f"/apps/{app_id}/appInfos")["data"]
    info = next(i for i in infos if i["attributes"].get("appStoreState") != "READY_FOR_SALE") if len(infos) > 1 else infos[0]
    call("PATCH", f"/appInfos/{info['id']}", {"data": {"type": "appInfos", "id": info["id"], "relationships": {
        k: rel("appCategories", app_meta[k]) for k in ("primaryCategory", "primarySubcategoryOne", "primarySubcategoryTwo", "secondaryCategory") if app_meta.get(k)}}})
    existing = {l["attributes"]["locale"]: l["id"] for l in call("GET", f"/appInfos/{info['id']}/appInfoLocalizations")["data"]}
    for m in locales:
        attrs = {k: m[k] for k in ("name", "subtitle", "privacyPolicyUrl")}
        if m["locale"] in existing:
            call("PATCH", f"/appInfoLocalizations/{existing[m['locale']]}",
                 {"data": {"type": "appInfoLocalizations", "id": existing[m["locale"]], "attributes": attrs}})
        else:
            call("POST", "/appInfoLocalizations", {"data": {"type": "appInfoLocalizations",
                 "attributes": dict(attrs, locale=m["locale"]), "relationships": {"appInfo": rel("appInfos", info["id"])}}})
        print("app info", m["locale"], "ok")

    # App Store version (editable one)
    versions = call("GET", f"/apps/{app_id}/appStoreVersions", **{"filter[platform]": "IOS"})["data"]
    version = next(v for v in versions if v["attributes"]["appStoreState"] in
                   ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"))
    vid = version["id"]
    call("PATCH", f"/appStoreVersions/{vid}", {"data": {"type": "appStoreVersions", "id": vid, "attributes": {
        "versionString": app_meta["versionString"], "copyright": app_meta["copyright"]}}})
    print("version", app_meta["versionString"], "ok")

    vlocs = {l["attributes"]["locale"]: l["id"] for l in call("GET", f"/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]}
    for m in locales:
        attrs = {k: m[k] for k in ("description", "keywords", "promotionalText", "supportUrl", "marketingUrl")}
        if m["locale"] in vlocs:
            call("PATCH", f"/appStoreVersionLocalizations/{vlocs[m['locale']]}",
                 {"data": {"type": "appStoreVersionLocalizations", "id": vlocs[m["locale"]], "attributes": attrs}})
        else:
            r = call("POST", "/appStoreVersionLocalizations", {"data": {"type": "appStoreVersionLocalizations",
                     "attributes": dict(attrs, locale=m["locale"]), "relationships": {"appStoreVersion": rel("appStoreVersions", vid)}}})
            vlocs[m["locale"]] = r["data"]["id"]
        print("texts", m["locale"], "ok")

    # Review details
    detail = call("GET", f"/appStoreVersions/{vid}/appStoreReviewDetail").get("data")
    if detail:
        call("PATCH", f"/appStoreReviewDetails/{detail['id']}",
             {"data": {"type": "appStoreReviewDetails", "id": detail["id"], "attributes": review}})
    else:
        call("POST", "/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": review,
             "relationships": {"appStoreVersion": rel("appStoreVersions", vid)}}})
    print("review details ok")

    if not with_screens:
        return
    for m in locales:
      lid = vlocs[m["locale"]]
      for DISPLAY_TYPE, folder in m["screenshots"].items():
        sets = call("GET", f"/appStoreVersionLocalizations/{lid}/appScreenshotSets")["data"]
        sset = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == DISPLAY_TYPE), None)
        if sset:   # replace existing screenshots
            for shot in call("GET", f"/appScreenshotSets/{sset['id']}/appScreenshots")["data"]:
                call("DELETE", f"/appScreenshots/{shot['id']}")
        else:
            sset = call("POST", "/appScreenshotSets", {"data": {"type": "appScreenshotSets",
                        "attributes": {"screenshotDisplayType": DISPLAY_TYPE},
                        "relationships": {"appStoreVersionLocalization": rel("appStoreVersionLocalizations", lid)}}})["data"]
        for f in sorted((STORE / folder).glob("*.png")):
            data = f.read_bytes()
            shot = call("POST", "/appScreenshots", {"data": {"type": "appScreenshots",
                        "attributes": {"fileName": f.name, "fileSize": len(data)},
                        "relationships": {"appScreenshotSet": rel("appScreenshotSets", sset["id"])}}})["data"]
            for op in shot["attributes"]["uploadOperations"]:
                chunk = data[op["offset"]:op["offset"] + op["length"]]
                headers = {h["name"]: h["value"] for h in op["requestHeaders"]}
                r = requests.request(op["method"], op["url"], data=chunk, headers=headers)
                if r.status_code >= 400:
                    sys.exit(f"upload {f.name}: {r.status_code} {r.text[:300]}")
            call("PATCH", f"/appScreenshots/{shot['id']}", {"data": {"type": "appScreenshots", "id": shot["id"],
                 "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
            print("screenshot", m["locale"], f.name, "ok")


if __name__ == "__main__":
    main()
