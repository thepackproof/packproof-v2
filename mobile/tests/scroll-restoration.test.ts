import assert from "node:assert/strict";
import test from "node:test";
import { createScrollRestoration } from "../src/ui/scroll-restoration.ts";

test("a fresh screen leaves native scrolling uncontrolled", () => {
  const scroll = createScrollRestoration();
  scroll.setViewportHeight(500);
  scroll.setContentHeight(2000);
  assert.equal(scroll.restore(true), null);
  assert.equal(scroll.recordOffset(0), 0);
  assert.equal(scroll.recordOffset(430), 430);
  assert.equal(scroll.restore(true), null);
});

test("saved position waits for geometry and async content without saving initial zero events", () => {
  const scroll = createScrollRestoration(650);
  assert.equal(scroll.recordOffset(0), null);
  assert.equal(scroll.restore(true), null);
  scroll.setViewportHeight(500);
  assert.equal(scroll.restore(true), null);
  scroll.setContentHeight(700);
  assert.equal(scroll.restore(false), null);
  assert.equal(scroll.recordOffset(0), null);
  scroll.setContentHeight(1500);
  assert.equal(scroll.restore(true), 650);
  assert.equal(scroll.recordOffset(0), null);
  assert.equal(scroll.recordOffset(650), 650);
  assert.equal(scroll.recordOffset(810), 810);
});

test("restoration clamps to available content and runs only once after later layout changes", () => {
  const scroll = createScrollRestoration(1400);
  scroll.setViewportHeight(500);
  scroll.setContentHeight(1000);
  assert.equal(scroll.restore(true), 500);
  assert.equal(scroll.recordOffset(500), 500);
  assert.equal(scroll.recordOffset(340), 340);
  scroll.setViewportHeight(450);
  scroll.setContentHeight(2400);
  assert.equal(scroll.restore(true), null);
  assert.equal(scroll.restore(false), null);
  assert.equal(scroll.restore(true), null);
  assert.equal(scroll.recordOffset(200), 200);
});

test("a drag cancels delayed restoration permanently and preserves the user's new position", () => {
  const scroll = createScrollRestoration(900);
  scroll.setViewportHeight(500);
  scroll.setContentHeight(600);
  assert.equal(scroll.restore(false), null);
  scroll.cancelRestoration();
  assert.equal(scroll.recordOffset(60), 60);
  scroll.setContentHeight(2200);
  assert.equal(scroll.restore(true), null);
  assert.equal(scroll.recordOffset(480), 480);
});

test("a new gesture also releases acknowledgement gating if native restoration has not completed", () => {
  const scroll = createScrollRestoration(900);
  scroll.setViewportHeight(500);
  scroll.setContentHeight(2000);
  assert.equal(scroll.restore(true), 900);
  scroll.cancelRestoration();
  assert.equal(scroll.recordOffset(140), 140);
  assert.equal(scroll.restore(true), null);
});

test("native pixel rounding is accepted while stale positions are ignored", () => {
  const scroll = createScrollRestoration(410.4);
  scroll.setViewportHeight(500);
  scroll.setContentHeight(1600);
  assert.equal(scroll.restore(true), 410.4);
  assert.equal(scroll.recordOffset(12), null);
  assert.equal(scroll.recordOffset(410), 410);
  assert.equal(scroll.recordOffset(700), 700);
});

test("returning to a saved tab gets a new one-shot restoration with short content clamped to zero", () => {
  const oldTab = createScrollRestoration();
  const savedOffset = oldTab.recordOffset(530)!;
  const returnedTab = createScrollRestoration(savedOffset);
  returnedTab.setViewportHeight(600);
  returnedTab.setContentHeight(350);
  assert.equal(returnedTab.restore(true), 0);
  assert.equal(returnedTab.recordOffset(0), 0);
  assert.equal(returnedTab.restore(true), null);
});
