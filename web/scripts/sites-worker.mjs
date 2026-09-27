const API_ORIGIN = "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const associationPath = ["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association", "/apple-app-site-association"].includes(url.pathname);
    // OS verifiers require direct JSON on every declared hostname, including
    // www. Do this before hostname redirects and extensionless SPA routing.
    if (associationPath) {
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      const path = url.pathname === "/apple-app-site-association" ? "/.well-known/apple-app-site-association" : url.pathname;
      const response = await env.ASSETS.fetch(new Request(new URL(path, url.origin), { method: "GET", redirect: "manual" }));
      if (response.status !== 200) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      let body;
      try {
        body = await response.text();
        const value = JSON.parse(body);
        if (path.endsWith("assetlinks.json") ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value) || !value.applinks) throw new Error("Invalid association");
      } catch { return new Response(null, { status: 404, headers: { "cache-control": "no-store" } }); }
      return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": "application/json", "cache-control": "public,max-age=300", "x-content-type-options": "nosniff" } });
    }
    if (url.hostname === "www.thepackproof.com") {
      url.hostname = "thepackproof.com";
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname === "/delete-account") {
      url.pathname = "/new/delete-account";
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname.startsWith("/api/")) {
      // The destination is fixed. Never forward the private Site access cookie.
      const target = new URL(API_ORIGIN);
      target.pathname = url.pathname.slice(4);
      target.search = url.search;
      const headers = new Headers();
      for (const name of ["authorization", "content-type", "accept", "range", "if-none-match", "idempotency-key", "x-packproof-station-token", "x-shopify-hmac-sha256", "x-shopify-shop-domain", "x-shopify-topic", "x-shopify-webhook-id"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      try {
        const response = await fetch(target, {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
          redirect: "manual",
        });
        const outgoing = new Headers(response.headers);
        outgoing.delete("set-cookie");
        outgoing.set("cache-control", "no-store");
        outgoing.set("x-content-type-options", "nosniff");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
      } catch {
        return Response.json({ error: { message: "PackProof is temporarily unavailable. Please try again.", code: "UPSTREAM_UNAVAILABLE" } }, { status: 502, headers: { "cache-control": "no-store" } });
      }
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const isAsset = /\.[a-z0-9]+$/i.test(url.pathname);
    const assetUrl = new URL(isAsset ? url.pathname : "/index.html", url.origin);
    const response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", /^\/(app|capture|admin)(\/|$)/.test(url.pathname) ? "no-referrer" : "strict-origin-when-cross-origin");
    if (!isAsset) headers.set("cache-control", "no-cache");
    return new Response(response.body, { status: response.status, headers });
  },
};
