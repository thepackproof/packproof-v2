import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
import type { AdminIdentity } from "./types";

/** The API checks the current DB grant on every call. This is only navigation state. */
export function useAdminAccess(api: PackProofApi, accountKey: string) {
  const [grant,setGrant]=useState<{api:PackProofApi;key:string;identity:AdminIdentity|null;error:boolean}|null>(null);
  useEffect(()=>{
    let active=true;let revision=0;
    const refresh=()=>{const current=++revision;if(!accountKey)return;
      void api.adminCapabilities<{userId:string;roles:string[];isAdmin:boolean;environment?:string}>().then(result=>{const identity=result.isAdmin===true&&result.roles?.includes("SYSTEM_ADMIN")?{userId:result.userId,role:"SYSTEM_ADMIN",environment:result.environment}:null;if(active&&current===revision)setGrant({api,key:accountKey,identity,error:false});})
        .catch(()=>{if(active&&current===revision)setGrant({api,key:accountKey,identity:null,error:true});});};
    refresh();const visible=()=>{if(document.visibilityState!=="hidden")refresh();};
    document.addEventListener("visibilitychange",visible);
    return()=>{active=false;revision++;document.removeEventListener("visibilitychange",visible);};
  },[api,accountKey]);
  const current=grant?.api===api&&grant.key===accountKey?grant:null;
  return {loading:!!accountKey&&!current,identity:current?.identity??null,allowed:!!current?.identity,error:current?.error??false};
}
