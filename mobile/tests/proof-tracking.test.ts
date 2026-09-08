import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedMapZoom, canMapCoordinates, isHistoricalReport, isMapTileCacheFresh, MAP_TILE_CACHE_MAX_AGE_MS, reportedCoordinates, trackingLocationSearchUrl, trackingMapTiles, trackingMapUrl } from "../src/copy/tracking.ts";

test("visible map tiles are reused for seven days and stale or invalid file timestamps expire", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  assert.equal(isMapTileCacheFresh(now / 1000, now), true);
  assert.equal(isMapTileCacheFresh((now - MAP_TILE_CACHE_MAX_AGE_MS + 1) / 1000, now), true);
  assert.equal(isMapTileCacheFresh((now - MAP_TILE_CACHE_MAX_AGE_MS) / 1000, now), false);
  assert.equal(isMapTileCacheFresh((now + 1000) / 1000, now), false);
  assert.equal(isMapTileCacheFresh(NaN, now), false);
});

test("tracking uses explicit provider coordinates and never substitutes a place name or empty value", () => {
  assert.deepEqual(reportedCoordinates({ tracking_location: { latitude: "39.9612", longitude: "-82.9988" } }), { latitude: 39.9612, longitude: -82.9988 });
  assert.deepEqual(reportedCoordinates({ coordinates: { lat: 0, lon: 0 } }), { latitude: 0, longitude: 0 });
  for (const data of [{ location: "Columbus, Ohio" }, { lat: "", lng: "" }, { latitude: null, longitude: false }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: Infinity, lng: 1 }, { lat: "NaN", lng: 1 }, null, []]) assert.equal(reportedCoordinates(data), null);
  const polar = reportedCoordinates({ latitude: 90, longitude: 0 });
  assert.deepEqual(polar, { latitude: 90, longitude: 0 });
  assert.equal(canMapCoordinates(polar), false, "retain a polar report without pretending the map can display it");
});

test("map requests cover the viewport and correctly place the reported point at its center", () => {
  const tiles = trackingMapTiles({ latitude: 0, longitude: 0 }, 3, 300, 300);
  assert.equal(tiles.length, 4);
  const northeastTile = tiles.find((tile) => tile.uri.endsWith("/3/4/3.png"));
  assert.deepEqual(northeastTile, { key: "3/4/3", uri: "https://tile.openstreetmap.org/3/4/3.png", left: 150, top: -106 });
  const southeastTile = tiles.find((tile) => tile.uri.endsWith("/3/4/4.png"));
  assert.equal(southeastTile?.left, 150);
  assert.equal(southeastTile?.top, 150);
  assert.deepEqual(trackingMapTiles({ latitude: 0, longitude: 0 }, 12, 0, 300), []);
  assert.deepEqual(trackingMapTiles({ latitude: 90, longitude: 0 }, 12, 300, 300), []);
  assert.deepEqual(trackingMapTiles({ latitude: 0, longitude: 0 }, 12, Infinity, 300), []);
});

test("tile indexes wrap at the antimeridian and remain bounded near the map poles", () => {
  for (const point of [{ latitude: 0, longitude: 180 }, { latitude: 0, longitude: -180 }, { latitude: 85.05112878, longitude: 0 }, { latitude: -85.05112878, longitude: 0 }]) {
    const tiles = trackingMapTiles(point, 3, 300, 300);
    assert(tiles.length > 0 && tiles.length <= 4);
    for (const tile of tiles) {
      const match = /\/3\/(\d+)\/(\d+)\.png$/.exec(tile.uri);
      assert(match);
      assert(Number(match[1]) >= 0 && Number(match[1]) < 8);
      assert(Number(match[2]) >= 0 && Number(match[2]) < 8);
    }
  }
  assert.equal(boundedMapZoom(-1), 3);
  assert.equal(boundedMapZoom(30), 16);
  assert.equal(boundedMapZoom(NaN), 12);
});

test("map links retain reported coordinates, searches escape locations, and stale reports use a strict 48-hour boundary", () => {
  assert.equal(trackingMapUrl({ latitude: 39.9612, longitude: -82.9988 }), "https://www.openstreetmap.org/?mlat=39.9612&mlon=-82.9988#map=12/39.9612/-82.9988");
  assert.equal(trackingLocationSearchUrl("A & B / Town"), "https://www.openstreetmap.org/search?query=A%20%26%20B%20%2F%20Town");
  assert.equal(trackingLocationSearchUrl("  "), null);
  const time = Date.parse("2026-09-06T12:00:00Z");
  assert.equal(isHistoricalReport("2026-09-04T12:00:00Z", time), false);
  assert.equal(isHistoricalReport("2026-09-04T11:59:59Z", time), true);
  assert.equal(isHistoricalReport("invalid", time), false);
  assert.equal(isHistoricalReport("2026-09-07T12:00:00Z", time), false);
});


test("tracking empty and failure copy does not invent carrier movement", async () => {
  const { trackingState } = await import("../src/copy/tracking-state.ts");
  const base = { events: [] };
  assert.equal(trackingState(base).kind, "missing_label");
  assert.equal(trackingState({ ...base, trackingNumber: "known" }).kind, "unavailable");
  const sync = { available: true, connectionId: "connection", status: "ACTIVE", provider: "shippo", adapterKey: "shippo" };
  assert.equal(trackingState({ ...base, trackingNumber: "known", sync }).kind, "awaiting_scan");
  assert.equal(trackingState({ ...base, trackingNumber: "known", sync: { ...sync, available: false, status: "ERROR" } }).kind, "unavailable");
  assert.equal(trackingState({ ...base, trackingNumber: "known", sync, refreshError: "network" }).kind, "failed");
  const registration = { state: "WAITING_FOR_CONNECTION", carrier: null, mode: "live", errorCode: null, registeredAt: null };
  assert.equal(trackingState({ ...base, trackingNumber: "known", registration }).kind, "unavailable");
  assert.equal(trackingState({ ...base, trackingNumber: "known", registration: { ...registration, state: "PENDING" } }).kind, "pending");
  assert.equal(trackingState({ ...base, trackingNumber: "known", registration: { ...registration, state: "REGISTERED", mode: "test" } }).kind, "unavailable");
});
