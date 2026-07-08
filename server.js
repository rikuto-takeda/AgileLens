const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const rootDir = __dirname;

loadEnv(".env");
loadEnv(".env.local");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);
const supabaseUrl = trimTrailingSlash(process.env.SUPABASE_URL || "");
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
const githubScopes = process.env.GITHUB_OAUTH_SCOPES || "repo read:user user:email";

const cookies = {
  access: "agilelens_access",
  refresh: "agilelens_refresh",
  verifier: "agilelens_pkce_verifier",
  state: "agilelens_oauth_state",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, getRequestOrigin(req));

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      await handleMe(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/github") {
      await handleGithubStart(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/callback") {
      await handleAuthCallback(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      await handleLogout(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, authConfigured: isAuthConfigured() });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url);
      return;
    }

    sendJson(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal_server_error" });
  }
});

server.listen(port, host, () => {
  console.log(`AgileLens server running at http://${host}:${port}/`);
});

async function handleGithubStart(req, res) {
  if (!isAuthConfigured()) {
    redirect(res, "/#/login?auth_error=missing_supabase_config");
    return;
  }

  const origin = getAppOrigin(req);
  const state = randomToken(24);
  const verifier = randomToken(64);
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const callbackUrl = new URL("/auth/callback", origin);
  callbackUrl.searchParams.set("state", state);

  const authorizeUrl = new URL("/auth/v1/authorize", supabaseUrl);
  authorizeUrl.searchParams.set("provider", "github");
  authorizeUrl.searchParams.set("redirect_to", callbackUrl.toString());
  authorizeUrl.searchParams.set("scopes", githubScopes);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "s256");

  setCookies(res, [
    serializeCookie(cookies.verifier, verifier, {
      httpOnly: true,
      maxAge: 10 * 60,
      path: "/auth",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(req),
    }),
    serializeCookie(cookies.state, state, {
      httpOnly: true,
      maxAge: 10 * 60,
      path: "/auth",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(req),
    }),
  ]);
  redirect(res, authorizeUrl.toString());
}

async function handleAuthCallback(req, res, url) {
  const cookieJar = parseCookies(req);
  const expectedState = cookieJar[cookies.state];
  const verifier = cookieJar[cookies.verifier];
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    clearAuthChallengeCookies(res, req);
    redirect(res, `/#/login?auth_error=${encodeURIComponent(providerError)}`);
    return;
  }

  if (!isAuthConfigured() || !code || !verifier || !expectedState || state !== expectedState) {
    clearAuthChallengeCookies(res, req);
    redirect(res, "/#/login?auth_error=invalid_auth_callback");
    return;
  }

  try {
    const session = await exchangeCodeForSession(code, verifier);
    if (!session.access_token || !session.refresh_token) {
      throw new Error("Supabase Auth did not return a complete session.");
    }
    const user = session.user || (await getSupabaseUser(session.access_token));
    await upsertUserProfile(user, session);
    clearAuthChallengeCookies(res, req);
    setSessionCookies(res, req, session);
    redirect(res, "/#/projects/repo-1/board");
  } catch (error) {
    console.error(error);
    clearAuthChallengeCookies(res, req);
    redirect(res, "/#/login?auth_error=exchange_failed");
  }
}

async function handleMe(req, res) {
  if (!isAuthConfigured()) {
    sendJson(res, 200, { authenticated: false, configured: false });
    return;
  }

  const cookieJar = parseCookies(req);
  let accessToken = cookieJar[cookies.access];
  const refreshToken = cookieJar[cookies.refresh];

  if (!accessToken && !refreshToken) {
    sendJson(res, 200, { authenticated: false, configured: true });
    return;
  }

  try {
    let user;
    if (!accessToken && refreshToken) {
      const refreshed = await refreshSession(refreshToken);
      accessToken = refreshed.access_token;
      refreshed.refresh_token = refreshed.refresh_token || refreshToken;
      setSessionCookies(res, req, refreshed);
      user = refreshed.user || (await getSupabaseUser(accessToken));
    } else {
      try {
        user = await getSupabaseUser(accessToken);
      } catch (error) {
        if (!refreshToken) throw error;
        const refreshed = await refreshSession(refreshToken);
        accessToken = refreshed.access_token;
        refreshed.refresh_token = refreshed.refresh_token || refreshToken;
        setSessionCookies(res, req, refreshed);
        user = refreshed.user || (await getSupabaseUser(accessToken));
      }
    }

    const profile = await getPublicUserProfile(accessToken, user).catch(() => null);
    sendJson(res, 200, {
      authenticated: true,
      configured: true,
      user: normalizeUserForClient(user, profile),
    });
  } catch (error) {
    clearSessionCookies(res, req);
    sendJson(res, 200, { authenticated: false, configured: true });
  }
}

async function handleLogout(req, res) {
  const accessToken = parseCookies(req)[cookies.access];
  if (accessToken && isAuthConfigured()) {
    await supabaseFetch("/auth/v1/logout", {
      method: "POST",
      accessToken,
    }).catch(() => null);
  }

  clearSessionCookies(res, req);
  sendJson(res, 200, { ok: true });
}

async function exchangeCodeForSession(code, verifier) {
  return supabaseFetch("/auth/v1/token?grant_type=pkce", {
    method: "POST",
    body: {
      auth_code: code,
      code_verifier: verifier,
    },
  });
}

async function refreshSession(refreshToken) {
  return supabaseFetch("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: {
      refresh_token: refreshToken,
    },
  });
}

async function getSupabaseUser(accessToken) {
  return supabaseFetch("/auth/v1/user", {
    method: "GET",
    accessToken,
  });
}

async function upsertUserProfile(user, session) {
  const profile = getGithubProfile(user);
  if (!profile.github_id) {
    throw new Error("GitHub user id was not returned by Supabase Auth.");
  }

  const payload = {
    id: user.id,
    github_id: profile.github_id,
    username: profile.username,
    avatar_url: profile.avatar_url,
  };

  if (session.provider_token) {
    payload.github_access_token = session.provider_token;
  }

  await supabaseFetch("/rest/v1/users?on_conflict=id", {
    method: "POST",
    accessToken: session.access_token,
    headers: {
      Prefer: "resolution=merge-duplicates",
    },
    body: payload,
  });
}

async function getPublicUserProfile(accessToken, user) {
  const rows = await supabaseFetch(
    `/rest/v1/users?id=eq.${encodeURIComponent(user.id)}&select=id,github_id,username,avatar_url`,
    {
      method: "GET",
      accessToken,
    },
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function supabaseFetch(pathname, options = {}) {
  const headers = {
    apikey: supabaseAnonKey,
    "Content-Type": "application/json",
    ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
    ...(options.headers || {}),
  };

  const response = await fetch(`${supabaseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.msg || data?.message || data?.error_description || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(rootDir, normalizedPath));

  if (!filePath.startsWith(rootDir) || filePath.includes(`${path.sep}.git${path.sep}`)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendText(res, 404, "Not found");
  }
}

function normalizeUserForClient(user, profile) {
  const githubProfile = getGithubProfile(user);
  return {
    id: user.id,
    email: user.email || null,
    github_id: profile?.github_id || githubProfile.github_id,
    username: profile?.username || githubProfile.username,
    avatar_url: profile?.avatar_url || githubProfile.avatar_url,
  };
}

function getGithubProfile(user) {
  const metadata = user.user_metadata || {};
  const identity = (user.identities || []).find((item) => item.provider === "github");
  const identityData = identity?.identity_data || {};
  const fallbackName = user.email ? user.email.split("@")[0] : "github-user";

  return {
    github_id: stringValue(
      metadata.provider_id ||
        identityData.provider_id ||
        identityData.sub ||
        identityData.user_id ||
        identityData.id,
    ),
    username:
      metadata.user_name ||
      metadata.preferred_username ||
      identityData.user_name ||
      identityData.preferred_username ||
      metadata.name ||
      identityData.name ||
      fallbackName,
    avatar_url: metadata.avatar_url || identityData.avatar_url || null,
  };
}

function setSessionCookies(res, req, session) {
  const secure = shouldUseSecureCookies(req);
  const accessMaxAge = Number(session.expires_in || 3600);
  const refreshMaxAge = 60 * 60 * 24 * 30;

  setCookies(res, [
    serializeCookie(cookies.access, session.access_token, {
      httpOnly: true,
      maxAge: accessMaxAge,
      path: "/",
      sameSite: "Lax",
      secure,
    }),
    serializeCookie(cookies.refresh, session.refresh_token, {
      httpOnly: true,
      maxAge: refreshMaxAge,
      path: "/",
      sameSite: "Lax",
      secure,
    }),
  ]);
}

function clearSessionCookies(res, req) {
  const secure = shouldUseSecureCookies(req);
  setCookies(res, [
    serializeCookie(cookies.access, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure,
    }),
    serializeCookie(cookies.refresh, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure,
    }),
  ]);
}

function clearAuthChallengeCookies(res, req) {
  const secure = shouldUseSecureCookies(req);
  setCookies(res, [
    serializeCookie(cookies.verifier, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/auth",
      sameSite: "Lax",
      secure,
    }),
    serializeCookie(cookies.state, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/auth",
      sameSite: "Lax",
      secure,
    }),
  ]);
}

function setCookies(res, values) {
  const existing = res.getHeader("Set-Cookie");
  const current = Array.isArray(existing) ? existing : existing ? [existing] : [];
  res.setHeader("Set-Cookie", [...current, ...values]);
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return header.split(";").reduce((acc, part) => {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) return acc;
    acc[name] = decodeURIComponent(valueParts.join("="));
    return acc;
  }, {});
}

function getRequestOrigin(req) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${req.headers.host || `${host}:${port}`}`;
}

function getAppOrigin(req) {
  return process.env.APP_ORIGIN || getRequestOrigin(req);
}

function shouldUseSecureCookies(req) {
  return getAppOrigin(req).startsWith("https://");
}

function isAuthConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomToken(byteLength) {
  return base64url(crypto.randomBytes(byteLength));
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function loadEnv(fileName) {
  const filePath = path.join(rootDir, fileName);
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) return;

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  });
}
