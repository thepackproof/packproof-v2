import { afterEach, expect, it } from "vitest";
import request from "supertest";
import { auth, commitFulfillmentAndAttest, createHarness, login, type TestHarness } from "./helpers.js";
import { createAccessLink } from "../src/domain/access-links.js";
import { getPublicProof } from "../src/domain/public-proof.js";
import { previewDisclosure } from "../src/domain/disclosure.js";
let harness:TestHarness;
afterEach(async()=>{await harness?.close();});
it("requires a newly reviewed statements scope and does not expand a historical shared link",async()=>{
  harness=await createHarness();
  const seller=await login(harness.app,"scope-compatibility-seller");
  const transaction=await request(harness.app).post("/transactions").set(auth(seller)).send({itemTitle:"Synthetic scope fixture"}).expect(201);
  const created=await request(harness.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller)).expect(200);
  const proofId=created.body.proofId;
  await commitFulfillmentAndAttest(harness,seller,proofId);
  const link=await createAccessLink(harness.db,harness.clock,seller,proofId,{scope:"EVIDENCE_VIEW",publicWebBaseUrl:"https://example.test"});
  await harness.db.query(`INSERT INTO proof_disclosure_grants(access_link_id,scope_version,policy_version,purpose,fields,media,preview_hash,created_by_user_id,created_at)
    VALUES($1,1,'packproof.disclosure/v1','SHARED_PROOF',$2::jsonb,'[]'::jsonb,'historically-reviewed-fixture',$3,$4)`,
    [link.accessLinkId,JSON.stringify(["status","order","shipping","evidence"]),seller,harness.clock.now().toISOString()]);
  const historical=await getPublicProof(harness.db,harness.clock,link.token);
  expect(historical.disclosure.fields).not.toContain("statements");
  expect(historical.statements).toEqual([]);
  const reviewed=await previewDisclosure(harness.db,seller,proofId,{purpose:"SHARED_PROOF"});
  expect(reviewed.statements).toHaveLength(1);
  expect(reviewed.statements[0]).toMatchObject({attributedTo:"Seller account",hardwareOriginVerified:false,legalIdentityVerified:false});
  expect(reviewed.statements[0]).not.toHaveProperty("authorization");
},30000);
