import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { migrate } from "../src/db/migrate.js";
import { createEtsyRequestBudget } from "../src/integrations/etsy/request-budget.js";

describe("Etsy application request budget", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {await close?.(); close=undefined;});
  async function setup(limit=3) {
    const opened=await createPgliteDatabase();close=opened.close;
    await migrate(opened.db);
    let now=Date.parse("2026-09-07T12:00:00Z");
    const clock={now:()=>new Date(now)};
    const options={dailyLimit:limit,wait:async(ms:number)=>{now+=ms;}};
    return {db:opened.db,clock,advance:(ms:number)=>{now+=ms;},a:createEtsyRequestBudget(opened.db,clock,"synthetic-shared-key",options),b:createEtsyRequestBudget(opened.db,clock,"synthetic-shared-key",options)};
  }
  it("shares one rolling-day allowance across independent API and worker instances", async () => {
    const {a,b,advance}=await setup();
    await a.beforeRequest(); await b.beforeRequest(); await a.beforeRequest();
    await expect(b.beforeRequest()).rejects.toMatchObject({code:"PROVIDER_RATE_LIMITED"});
    advance(86_400_000+60_000);
    await expect(b.beforeRequest()).resolves.toBeUndefined();
  });
  it("persists provider cooldown across instances and does not shorten a longer pause", async () => {
    const {a,b,advance}=await setup(10);
    await a.beforeRequest();
    await a.afterResponse(new Response(null,{status:429,headers:{"retry-after":"120"}}));
    await b.afterResponse(new Response(null,{status:429,headers:{"retry-after":"1"}}));
    await expect(b.beforeRequest()).rejects.toMatchObject({code:"PROVIDER_RATE_LIMITED",retryAfterSeconds:120});
    advance(120_001);
    await expect(b.beforeRequest()).resolves.toBeUndefined();
  });
  it("backs off before exhausting Etsy's remaining daily budget", async () => {
    const {a,b,db}=await setup(10);
    await a.beforeRequest();
    await a.afterResponse(new Response("{}",{status:200,headers:{"x-remaining-today":"10"}}));
    await expect(b.beforeRequest()).rejects.toMatchObject({code:"PROVIDER_RATE_LIMITED",retryAfterSeconds:3600});
    const rows=await db.query("SELECT * FROM etsy_request_budget");
    expect(JSON.stringify(rows)).not.toContain("synthetic-shared-key");
  });
});
