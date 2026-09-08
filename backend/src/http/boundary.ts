import { randomUUID,createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Express,Request,Response } from "express";
import type { Database } from "../db/database.js";
import { DomainError,errorCodeFromSql } from "../domain/errors.js";
import { IntegrationError } from "../domain/integration-errors.js";
import type { ErrorRequestHandler, RequestHandler } from "express";

/** Apply before every router, including provider and notification routes. */
export function httpBoundary(corsOrigins: readonly string[]): RequestHandler {
  return (req, res, next) => {
    // Proofs, bearer viewing links, and account responses must never be cached.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.vary("Origin");
    const origin = req.header("Origin");
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-PackProof-Station-Token, X-Intake-Device-Token, X-PackProof-Intake-Version, Range");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Body-parser errors must use the same safe JSON contract as domain errors. */
export const requestBodyErrors: ErrorRequestHandler = (error, _req, res, next) => {
  const codes: Record<string, { status: number; code: string; message: string }> = {
    "entity.parse.failed": { status: 400, code: "INVALID_JSON", message: "Request body must be valid JSON" },
    "entity.too.large": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
    "encoding.unsupported": { status: 415, code: "UNSUPPORTED_ENCODING", message: "Request encoding is not supported" },
    "charset.unsupported": { status: 415, code: "UNSUPPORTED_CHARSET", message: "Request charset is not supported" },
  };
  const mapped = codes[error?.type];
  if (!mapped) return next(error);
  safeHttpError(new DomainError(mapped.code,mapped.message,mapped.status),res);
};

/** Generated locally: a caller cannot inject a log/correlation identifier. */
export const requestCorrelation:RequestHandler=(_req,res,next)=>{
  if(!res.locals.operationId)res.locals.operationId=randomUUID();
  res.setHeader('X-PackProof-Operation-Id',res.locals.operationId);next();
};
export function configureTrustedProxy(app:Pick<Express,'set'>,env:NodeJS.ProcessEnv=process.env):void {
  const values=(env.PACKPROOF_TRUSTED_PROXIES??'').split(',').map(value=>value.trim()).filter(Boolean);
  for(const value of values){
    const [ip,bits,...rest]=value.split('/');const family=isIP(ip);
    if(!family||rest.length||bits!==undefined&&(!/^\d+$/.test(bits)||Number(bits)<1||Number(bits)>(family===4?32:128)))
      throw new Error('PACKPROOF_TRUSTED_PROXIES requires explicit trusted addresses or bounded CIDRs');
  }
  app.set('trust proxy',values.length?values:false);
}
/** All replicas share one atomic counter. The subject must be server-authenticated when supplied. */
export function distributedRateLimit(db:Database,options:{scope:string;limit:number;windowMs:number;subject?:(req:Request)=>string}):RequestHandler {
  if(!/^[a-z0-9_-]{1,64}$/.test(options.scope)||options.limit<1||options.windowMs<1000)throw new Error('Invalid rate limit configuration');
  return (req,res,next)=>{void(async()=>{
    const now=Date.now(),window=Math.floor(now/options.windowMs),subject=options.subject?.(req)??req.ip??req.socket.remoteAddress??'unknown';
    const hash=createHash('sha256').update(`${options.scope}:${subject}`).digest('hex');
    const result=await db.query<{request_count:number}>(`INSERT INTO http_rate_windows(bucket_hash,window_start,request_count,expires_at) VALUES($1,$2,1,$3)
      ON CONFLICT(bucket_hash,window_start) DO UPDATE SET request_count=LEAST(http_rate_windows.request_count+1,$4) RETURNING request_count`,
      [hash,window,new Date((window+2)*options.windowMs).toISOString(),options.limit+1]);
    if(result.rows[0].request_count>options.limit){res.setHeader('Retry-After',String(Math.ceil(((window+1)*options.windowMs-now)/1000)));throw new DomainError('RATE_LIMITED','Please wait before trying again',429);}
    next();
  })().catch(next);};
}
/** Domain messages are application-authored; raw SQL/provider/exception text never crosses the boundary. */
export function safeHttpError(error:unknown,res:Response):void {
  if(res.headersSent){res.destroy();return;}
  const operationId=res.locals.operationId??randomUUID();
  const sqlCode=errorCodeFromSql(error);
  const domain=error instanceof DomainError;
  const code=domain?error.code:sqlCode??'INTERNAL';
  const status=domain?error.httpStatus:sqlCode?409:500;
  const retryable=error instanceof IntegrationError?error.retryable:status===429||status===503;
  const message=domain?error.message:sqlCode?'The record cannot be changed in its current state':'The request could not be completed';
  if(status>=500)console.error(JSON.stringify({event:'http_request_failed',code,operationId,status}));
  res.setHeader('X-PackProof-Operation-Id',operationId);
  res.status(status).json({error:{code,message,retryable,operationId,nextAction:retryable?'Retry the same operation. Your saved recording remains available.':status===401?'Sign in to continue.':'Review the request or contact support with this operation ID.'}});
}
