import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PackProofApi } from "../api/client";
import { useAdminAccess } from "../admin/useAdminAccess";
import AdminWorkspace from "../admin/AdminWorkspace";
import { ThemeProvider } from "../theme/ThemeProvider";
import { AppNav } from "../components/AppNav";
import type { WebSession } from "../auth/session";

describe("administrative boundary",()=>{
  it("uses the server role and drops a grant immediately when accounts change",async()=>{
    const admin={adminCapabilities:vi.fn().mockResolvedValue({userId:"admin",roles:["SYSTEM_ADMIN"],isAdmin:true})} as unknown as PackProofApi;
    let finish!:(value:unknown)=>void;
    const user={adminCapabilities:vi.fn(()=>new Promise(resolve=>{finish=resolve;}))} as unknown as PackProofApi;
    const {result,rerender}=renderHook(({api,id})=>useAdminAccess(api,id),{initialProps:{api:admin,id:"admin"}});
    expect(result.current.allowed).toBe(false);await waitFor(()=>expect(result.current.allowed).toBe(true));
    rerender({api:user,id:"user"});expect(result.current.allowed).toBe(false);
    await act(async()=>finish({userId:"user",roles:[],isAdmin:false}));expect(result.current.allowed).toBe(false);
  });
  it("does not make admin data requests for a rejected capability",()=>{
    const adminRequest=vi.fn();
    render(<ThemeProvider><AdminWorkspace api={{adminRequest} as unknown as PackProofApi} access={{allowed:false,loading:false,identity:null}} accountName="User" onGo={()=>{}} onSignOut={()=>{}}/></ThemeProvider>);
    expect(screen.getByText("Administration access unavailable")).toBeInTheDocument();expect(adminRequest).not.toHaveBeenCalled();
  });
  it("hides admin navigation from regular users",()=>{
    const session={displayName:"User",userId:"user"} as WebSession;
    const {rerender}=render(<ThemeProvider><AppNav session={session} invitationCount={0} onGoHome={()=>{}} onOpenAccount={()=>{}}/></ThemeProvider>);
    expect(screen.queryByRole("link",{name:"Admin"})).not.toBeInTheDocument();
    rerender(<ThemeProvider><AppNav session={session} adminAllowed invitationCount={0} onGoHome={()=>{}} onOpenAccount={()=>{}}/></ThemeProvider>);
    expect(screen.getByRole("link",{name:"Admin"})).toHaveAttribute("href","/admin");
  });
  it("renders real overview contract and keeps an unavailable chart isolated",async()=>{
    window.history.replaceState({},"","/admin");
    const now=new Date().toISOString();
    const adminRequest=vi.fn((path:string)=>path.startsWith("/overview")?Promise.resolve({updatedAt:now,range:{from:now,to:now,previousFrom:now,previousTo:now},metrics:[{key:"users",label:"Total users",value:12,previous:null,status:"available"}],health:[{key:"db",label:"Database",status:"healthy",detail:"Connected",checkedAt:now}],attention:[],activity:[]}):Promise.reject(new Error("Metric source is unavailable")));
    render(<ThemeProvider><AdminWorkspace api={{adminRequest} as unknown as PackProofApi} access={{allowed:true,loading:false,identity:{userId:"admin",role:"SYSTEM_ADMIN"}}} accountName="Administrator" onGo={()=>{}} onSignOut={()=>{}}/></ThemeProvider>);
    await screen.findByText("Total users");expect(screen.getByText("12")).toBeInTheDocument();await screen.findByText("Metric source is unavailable");expect(screen.getByText("No observed issues requiring attention")).toBeInTheDocument();
  });
});
