"""Browser checks for the live ledger and launch/failure states. Uses test data only."""
import copy
import json
import pathlib
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "qa-output"
OUT.mkdir(exist_ok=True)
BASE = "http://127.0.0.1:8788"
with urllib.request.urlopen(BASE + "/api/state") as response:
    fixture = json.load(response)
passed = []
def ok(condition, name):
    assert condition, name
    passed.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width":1440,"height":1000}, reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until="networkidle")
    page.locator("#holders").get_by_text("137", exact=True).wait_for()
    ok(page.locator("#rows tr").count() == 12, "12 ledger rows render")
    ok(page.locator("#range").inner_text() == "125–136 of 137", "Newest page is shown first")
    ok("frozen" in page.locator("#split-check").inner_text(), "Frozen 50% split is verified")
    ok("revoked" in page.locator("#program-check").inner_text(), "Program permanence is shown")
    page.locator("#next").click()
    page.wait_for_function("document.getElementById('range').textContent === '113–124 of 137'")
    for _ in range(10):
        with page.expect_response("**/api/holders*"):
            page.locator("#next").click()
    page.wait_for_function("document.getElementById('range').textContent === '0–11 of 137'")
    ok(page.locator(".oncurve").count() == 1, "An on-curve address is flagged")
    ok(page.locator("#next").is_disabled(), "Older paging stops at zero")
    page.locator("#prev").click()
    page.wait_for_function("document.getElementById('range').textContent === '12–23 of 137'")
    ok(True, "Newer paging works")
    page.locator("summary").click()
    ok(page.locator(".derivation pre").is_visible(), "Independent derivation opens")
    page.locator("summary").click()
    page.screenshot(path=str(OUT/"desktop.png"), full_page=True)
    page.set_viewport_size({"width":390,"height":844})
    page.screenshot(path=str(OUT/"mobile.png"), full_page=True)
    ok(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile has no page overflow")
    ok(page.locator(".hero-art").evaluate("el => el.complete && el.naturalWidth > 0"), "Hero artwork loads")
    ok(page.locator("#buy").is_visible(), "Buy link appears for a registered production mint")
    ok(not errors, "No JavaScript errors")
    page.close()

    scenes = {}
    scenes["prelaunch"] = {"ready":False,"phase":"prelaunch","cluster":"mainnet-beta","ageMs":0,"refreshMs":30_000}
    scenes["empty"] = copy.deepcopy(fixture)
    scenes["empty"].update(holders=0,nextIndex=0,totalLocked="0",lockedPercent=0,vaultLamports=890880)
    scenes["stale"] = copy.deepcopy(fixture)
    scenes["stale"]["ageMs"] = 1_200_000
    scenes["upgradeable"] = copy.deepcopy(fixture)
    scenes["upgradeable"]["permanence"]["immutable"] = False
    scenes["curve"] = copy.deepcopy(fixture)
    scenes["curve"].update(market="bonding-curve",graduated=False)
    scenes["curve"]["split"] = {"exists":False,"editable":None,"shareholders":[],"vaultBps":None}
    scenes["unsafe"] = {"ready":False,"error":"<img src=x onerror=alert('xss')>","ageMs":0,"refreshMs":30_000}
    for name, scene in scenes.items():
        view = browser.new_page(viewport={"width":390,"height":844})
        view.on("pageerror", lambda e: errors.append(str(e)))
        view.route("**/api/state", lambda route, request, data=scene: route.fulfill(json=data))
        if name == "empty":
            view.route("**/api/holders*", lambda route: route.fulfill(json={"total":0,"from":0,"holders":[]}))
        view.goto(BASE, wait_until="networkidle")
        if name == "prelaunch":
            ok(view.locator("#launch-badge").inner_text()=="PRE-LAUNCH", "Prelaunch is explicit")
            ok(view.locator("#holders").inner_text()=="—" and view.locator("#buy").is_hidden(), "Prelaunch has no invented stats or buy link")
            view.screenshot(path=str(OUT/"prelaunch-mobile.png"),full_page=True)
        elif name == "empty":
            ok("No cycles yet" in view.locator("#rows").inner_text(), "Empty ledger explains waiting")
        elif name == "stale":
            ok("STALE" in view.locator("#status").inner_text(), "Old server snapshot is flagged")
        elif name == "upgradeable":
            ok("not established" in view.locator("#program-check").inner_text(), "Upgradeable program cannot claim permanence")
        elif name == "curve":
            ok("not configured" in view.locator("#split-check").inner_text(), "Missing fee routing is visible")
        elif name == "unsafe":
            ok(view.locator("#status img").count()==0 and "<img" in view.locator("#status").inner_text(), "Server error is rendered as text")
        view.close()

    view = browser.new_page()
    near_stale = copy.deepcopy(fixture)
    near_stale["ageMs"] = 89_500
    view.route("**/api/state",lambda route:route.fulfill(json=near_stale))
    view.goto(BASE,wait_until="networkidle")
    view.locator("#status.stale").wait_for(timeout=4000)
    ok(True,"Snapshot ages locally between polls")
    view.close()

    view = browser.new_page()
    view.goto(BASE,wait_until="networkidle")
    view.route("**/api/state",lambda route:route.abort())
    view.evaluate("window.dispatchEvent(new Event('focus'))")
    view.locator("#status.broken").wait_for()
    ok(view.locator("#holders").inner_text()=="137","Offline server preserves last known reading with warning")
    view.close()
    browser.close()
ok(not errors,"All failure states have no JavaScript errors")
(OUT/"results.json").write_text(json.dumps({"passed":len(passed),"checks":passed,"errors":errors},indent=2))
print(json.dumps({"passed":len(passed),"checks":passed},indent=2))
