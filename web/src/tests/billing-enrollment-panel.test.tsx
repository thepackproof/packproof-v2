import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {PlanBillingPanel,safeBillingDestination} from "../components/PlanBillingPanel";
import type {PackProofApi} from "../api/client";
afterEach(cleanup);
it("keeps billing out of the free pilot when the provider is disabled",async()=>{
  const billingRequest=vi.fn(async()=>({enabled:false,subscriptions:[],pendingCheckout:null}));
  render(<PlanBillingPanel api={{billingRequest} as unknown as PackProofApi}/>);
  await waitFor(()=>expect(billingRequest).toHaveBeenCalledWith("status"));
  expect(screen.queryByRole("region",{name:"Plan and billing"})).toBeNull();
  expect(billingRequest).toHaveBeenCalledTimes(1);
});
it("requires explicit offer acceptance and sends the exact displayed offer digest",async()=>{
  const billingRequest=vi.fn(async(path:string)=>path==="status"?{enabled:true,subscriptions:[],pendingCheckout:null}:path==="offer"?{enabled:true,offer:{version:"offer-test",sha256:"a".repeat(64),priceMinor:1200,currency:"USD",interval:"monthly",includedFinalizedProofs:25,maxRecordingSeconds:300,maxRecordingBytes:250000000}}:{state:"COMPLETE",url:null});
  render(<PlanBillingPanel api={{billingRequest} as unknown as PackProofApi}/>);
  const button=await screen.findByRole("button",{name:"Continue to secure checkout"});
  expect(button).toBeDisabled();
  expect(billingRequest.mock.calls.some(([path])=>path==="checkout")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(button);
  await waitFor(()=>expect(billingRequest).toHaveBeenCalledWith("checkout",expect.objectContaining({offerVersion:"offer-test",acceptedOfferSha256:"a".repeat(64),operationId:expect.any(String)})));
});
it("rejects credential-bearing, insecure and off-provider checkout URLs",()=>{
  for(const value of ["http://checkout.stripe.com/a","https://checkout.stripe.com.evil.test/a","https://user@checkout.stripe.com/a","https://billing.stripe.com/a"])
    expect(()=>safeBillingDestination(value,"checkout.stripe.com")).toThrow();
  expect(safeBillingDestination("https://checkout.stripe.com/c/pay/test","checkout.stripe.com")).toBe("https://checkout.stripe.com/c/pay/test");
});
