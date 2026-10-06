const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function configured(env) {
  return Boolean(env.ENGINE_ORIGIN && env.ENGINE_API_KEY);
}

function engineTarget(env, path, search = "") {
  const origin = String(env.ENGINE_ORIGIN || "").replace(/\/+$/, "");
  return origin + path + search;
}

function allowedGatewayPath(pathname) {
  if (pathname === "/gateway/health") return "/health";
  if (pathname === "/gateway/ready") return "/health/ready";
  if (pathname.startsWith("/gateway/api/artboard/")) {
    return pathname.slice("/gateway".length);
  }
  return null;
}

async function proxyEngine(request, env) {
  if (!configured(env)) {
    return json(
      {
        success: false,
        error: {
          code: "ENGINE_NOT_CONFIGURED",
          message: "Artboard AI engine connection is not configured for this deployment.",
        },
      },
      503,
    );
  }

  const source = new URL(request.url);
  const enginePath = allowedGatewayPath(source.pathname);
  if (!enginePath) {
    return json(
      {
        success: false,
        error: {
          code: "GATEWAY_ROUTE_NOT_ALLOWED",
          message: "The requested engine route is not available through this gateway.",
        },
      },
      404,
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  headers.set("authorization", "Bearer " + env.ENGINE_API_KEY);
  headers.set("accept", request.headers.get("accept") || "*/*");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(
      engineTarget(env, enginePath, source.search),
      init,
    );
  } catch {
    return json(
      {
        success: false,
        error: {
          code: "ENGINE_UNREACHABLE",
          message: "Artboard AI engine could not be reached.",
        },
      },
      502,
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.delete("access-control-allow-origin");
  responseHeaders.delete("access-control-allow-credentials");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/gateway/")) {
      return proxyEngine(request, env);
    }

    if (url.pathname === "/__tool/health") {
      return json({
        status: "ok",
        service: "Artboard AI Tool Gateway",
        engine_configured: configured(env),
      });
    }

    return env.ASSETS.fetch(request);
  },
};
