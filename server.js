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

let issueDescriptionColumnAvailable = true;

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

    if (req.method === "GET" && url.pathname === "/api/repositories") {
      await handleListRepositories(req, res);
      return;
    }

    const issuesMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/issues$/);
    if (req.method === "GET" && issuesMatch) {
      await handleListIssues(req, res, decodeURIComponent(issuesMatch[1]));
      return;
    }

    const generateTasksMatch = url.pathname.match(
      /^\/api\/repositories\/([^/]+)\/generate-claude-tasks$/,
    );
    if (req.method === "POST" && generateTasksMatch) {
      await handleGenerateClaudeTasks(req, res, decodeURIComponent(generateTasksMatch[1]));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/repositories") {
      await handleCreateRepository(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/github/repositories") {
      await handleListGithubRepositories(req, res);
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
    redirect(res, "/#/projects");
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

  try {
    const { accessToken, user } = await getAuthenticatedContext(req, res);
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

async function handleListRepositories(req, res) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    const repositories = await listRepositories(accessToken);
    sendJson(res, 200, { repositories });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleListIssues(req, res, repositoryId) {
  try {
    const { accessToken, user } = await getAuthenticatedContext(req, res);
    const repository = await getRepositoryById(accessToken, repositoryId);
    const profile = await getPrivateUserProfile(accessToken, user);
    const issues = await listIssues(accessToken, repositoryId);
    const claudeTasks = await getClaudeTasksForDisplay(repository, profile?.github_access_token);

    sendJson(res, 200, { issues: applyClaudeTaskDisplayTitles(issues, claudeTasks) });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleGenerateClaudeTasks(req, res, repositoryId) {
  try {
    const { accessToken, user } = await getAuthenticatedContext(req, res);
    const repository = await getRepositoryById(accessToken, repositoryId);
    const profile = await getPrivateUserProfile(accessToken, user);
    const markdown = await fetchGithubFileContent(repository, "CLAUDE.md", profile?.github_access_token);
    const tasks = extractTasksFromClaudeMarkdown(markdown);

    if (tasks.length === 0) {
      throw apiError(422, "claude_tasks_not_found", "CLAUDE.mdから生成できるタスクが見つかりませんでした。");
    }

    const existingIssues = await listIssues(accessToken, repositoryId);
    const existingTitles = new Set(
      existingIssues.map((issue) => normalizeComparableTask(issue.description || issue.title)),
    );
    const newTasks = tasks.filter((task) => !existingTitles.has(normalizeComparableTask(task.description)));

    const createdIssues =
      newTasks.length > 0
        ? await insertClaudeIssues(accessToken, repositoryId, newTasks)
        : [];
    const issues = await listIssues(accessToken, repositoryId);

    sendJson(res, 201, {
      created_count: createdIssues.length,
      skipped_count: tasks.length - newTasks.length,
      source_path: "CLAUDE.md",
      issues: applyClaudeTaskDisplayTitles(issues, tasks),
    });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleListGithubRepositories(req, res) {
  try {
    const { accessToken, user } = await getAuthenticatedContext(req, res);
    const profile = await getPrivateUserProfile(accessToken, user);
    const githubRepos = await listGithubRepositories(profile?.github_access_token);
    const registeredRepos = await listRepositories(accessToken);
    const registeredIds = new Set(
      registeredRepos.map((repo) => String(repo.github_repo_id)).filter(Boolean),
    );

    sendJson(res, 200, {
      repositories: githubRepos.map((repo) => ({
        id: String(repo.id),
        full_name: repo.full_name,
        repo_name: repo.name,
        owner_name: repo.owner.login,
        private: Boolean(repo.private),
        archived: Boolean(repo.archived),
        html_url: repo.html_url,
        updated_at: repo.updated_at,
        registered: registeredIds.has(String(repo.id)),
      })),
    });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleCreateRepository(req, res) {
  try {
    const { accessToken, user } = await getAuthenticatedContext(req, res);
    const body = await readJsonBody(req);
    const input = normalizeRepositoryInput(body);
    const profile = await getPrivateUserProfile(accessToken, user);
    const githubRepo = await resolveSelectedGithubRepository(input, profile?.github_access_token);
    const existingRepo = await findRepositoryByGithubId(accessToken, githubRepo.id);

    if (existingRepo) {
      sendJson(res, 200, { repository: existingRepo });
      return;
    }

    const repository = await createRepository(accessToken, user, githubRepo, input);
    sendJson(res, 201, { repository });
  } catch (error) {
    handleApiError(req, res, error);
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

async function getAuthenticatedContext(req, res) {
  if (!isAuthConfigured()) {
    throw apiError(503, "auth_not_configured", "Supabase is not configured.");
  }

  const cookieJar = parseCookies(req);
  let accessToken = cookieJar[cookies.access];
  const refreshToken = cookieJar[cookies.refresh];

  if (!accessToken && !refreshToken) {
    throw apiError(401, "unauthenticated", "Login is required.");
  }

  if (!accessToken && refreshToken) {
    const refreshed = await refreshSession(refreshToken);
    accessToken = refreshed.access_token;
    refreshed.refresh_token = refreshed.refresh_token || refreshToken;
    setSessionCookies(res, req, refreshed);
    return {
      accessToken,
      user: refreshed.user || (await getSupabaseUser(accessToken)),
    };
  }

  try {
    return {
      accessToken,
      user: await getSupabaseUser(accessToken),
    };
  } catch (error) {
    if (!refreshToken) throw error;

    const refreshed = await refreshSession(refreshToken);
    accessToken = refreshed.access_token;
    refreshed.refresh_token = refreshed.refresh_token || refreshToken;
    setSessionCookies(res, req, refreshed);

    return {
      accessToken,
      user: refreshed.user || (await getSupabaseUser(accessToken)),
    };
  }
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

async function getPrivateUserProfile(accessToken, user) {
  const rows = await supabaseFetch(
    `/rest/v1/users?id=eq.${encodeURIComponent(user.id)}&select=id,github_access_token`,
    {
      method: "GET",
      accessToken,
    },
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function getRepositoryById(accessToken, repositoryId) {
  const rows = await supabaseFetch(
    `/rest/v1/repositories?id=eq.${encodeURIComponent(
      repositoryId,
    )}&select=id,github_repo_id,repo_name,owner_name,full_name,hourly_wage,point_unit_price,synced_at,created_at&limit=1`,
    {
      method: "GET",
      accessToken,
    },
  );
  const repository = Array.isArray(rows) ? rows[0] : null;
  if (!repository) {
    throw apiError(404, "repository_not_found", "リポジトリが見つかりません。");
  }
  return repository;
}

async function listRepositories(accessToken) {
  const rows = await supabaseFetch(
    "/rest/v1/repositories?select=id,github_repo_id,repo_name,owner_name,full_name,hourly_wage,point_unit_price,synced_at,created_at&order=created_at.asc",
    {
      method: "GET",
      accessToken,
    },
  );
  return Array.isArray(rows) ? rows : [];
}

async function listIssues(accessToken, repositoryId) {
  try {
    const rows = await fetchIssueRows(accessToken, repositoryId);
    return Array.isArray(rows) ? rows.map(normalizeIssueRow) : [];
  } catch (error) {
    if (!issueDescriptionColumnAvailable || !isMissingIssueDescriptionColumn(error)) {
      throw error;
    }

    issueDescriptionColumnAvailable = false;
    const rows = await fetchIssueRows(accessToken, repositoryId);
    return Array.isArray(rows) ? rows.map(normalizeIssueRow) : [];
  }
}

async function insertClaudeIssues(accessToken, repositoryId, tasks) {
  try {
    const rows = await insertIssueRows(accessToken, repositoryId, tasks);
    return Array.isArray(rows) ? rows.map(normalizeIssueRow) : [];
  } catch (error) {
    if (!issueDescriptionColumnAvailable || !isMissingIssueDescriptionColumn(error)) {
      throw error;
    }

    issueDescriptionColumnAvailable = false;
    const rows = await insertIssueRows(accessToken, repositoryId, tasks);
    return Array.isArray(rows) ? rows.map(normalizeIssueRow) : [];
  }
}

async function fetchIssueRows(accessToken, repositoryId) {
  return supabaseFetch(
    `/rest/v1/issues?repository_id=eq.${encodeURIComponent(
      repositoryId,
    )}&select=${issueSelectColumns()}&order=created_at.asc`,
    {
      method: "GET",
      accessToken,
    },
  );
}

async function insertIssueRows(accessToken, repositoryId, tasks) {
  const payload = tasks.map((task) => {
    const issue = {
      repository_id: repositoryId,
      title: task.title,
      state: "open",
      kanban_column: "Backlog",
      story_point: task.storyPoint,
      labels: [{ name: "claude-generated", description: task.description }],
      source: "claude",
      assignee_username: null,
    };

    if (issueDescriptionColumnAvailable) {
      issue.description = task.description;
    }

    return issue;
  });

  return supabaseFetch(
    `/rest/v1/issues?select=${issueSelectColumns()}`,
    {
      method: "POST",
      accessToken,
      headers: {
        Prefer: "return=representation",
      },
      body: payload,
    },
  );
}

function issueSelectColumns() {
  const baseColumns =
    "id,repository_id,sprint_id,title,state,kanban_column,story_point,source,assignee_username,assignee_avatar_url,github_html_url,labels,created_at,updated_at";
  return issueDescriptionColumnAvailable
    ? `id,repository_id,sprint_id,title,description,state,kanban_column,story_point,source,assignee_username,assignee_avatar_url,github_html_url,labels,created_at,updated_at`
    : baseColumns;
}

function normalizeIssueRow(row) {
  const description =
    row.description || getIssueDescriptionFromLabels(row.labels) || (row.source === "claude" ? row.title : "");

  return {
    ...row,
    description,
  };
}

async function getClaudeTasksForDisplay(repository, githubAccessToken) {
  try {
    const markdown = await fetchGithubFileContent(repository, "CLAUDE.md", githubAccessToken);
    return extractTasksFromClaudeMarkdown(markdown);
  } catch (error) {
    return [];
  }
}

function applyClaudeTaskDisplayTitles(issues, claudeTasks) {
  const tasksByDetail = new Map(
    claudeTasks.map((task) => [normalizeComparableTask(task.description), task]),
  );
  const fallbackItems = [];

  const mappedIssues = issues.map((issue) => {
    if (issue.source !== "claude") return issue;

    const description = issue.description || issue.title;
    const matchedTask = tasksByDetail.get(normalizeComparableTask(description));

    if (matchedTask) {
      return {
        ...issue,
        title: matchedTask.title,
        description,
        task_context: matchedTask.contextLabel,
      };
    }

    const titleBase = makeContextTaskTitle("", description);
    const mappedIssue = {
      ...issue,
      title: titleBase,
      description,
      task_context: getFallbackTaskContext(description),
      titleBase,
    };
    fallbackItems.push(mappedIssue);
    return mappedIssue;
  });

  const fallbackCounts = fallbackItems.reduce((counts, issue) => {
    counts.set(issue.titleBase, (counts.get(issue.titleBase) || 0) + 1);
    return counts;
  }, new Map());
  const fallbackIndexes = new Map();

  return mappedIssues.map((issue) => {
    if (!issue.titleBase) return issue;

    const nextIndex = (fallbackIndexes.get(issue.titleBase) || 0) + 1;
    fallbackIndexes.set(issue.titleBase, nextIndex);

    const title =
      fallbackCounts.get(issue.titleBase) > 1 ? `${issue.titleBase}${nextIndex}` : issue.titleBase;
    const { titleBase, ...cleanIssue } = issue;
    return {
      ...cleanIssue,
      title,
    };
  });
}

function getIssueDescriptionFromLabels(labels) {
  if (!Array.isArray(labels)) return "";

  const detailLabel = labels.find(
    (label) => label && typeof label === "object" && typeof label.description === "string",
  );
  return detailLabel?.description || "";
}

function isMissingIssueDescriptionColumn(error) {
  const text = `${error.message || ""} ${JSON.stringify(error.data || {})}`;
  return text.includes("description") && text.includes("issues");
}

async function findRepositoryByGithubId(accessToken, githubRepoId) {
  const rows = await supabaseFetch(
    `/rest/v1/repositories?github_repo_id=eq.${encodeURIComponent(
      String(githubRepoId),
    )}&select=id,github_repo_id,repo_name,owner_name,full_name,hourly_wage,point_unit_price,synced_at,created_at&limit=1`,
    {
      method: "GET",
      accessToken,
    },
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function createRepository(accessToken, user, githubRepo, input) {
  const payload = {
    user_id: user.id,
    github_repo_id: String(githubRepo.id),
    repo_name: githubRepo.name,
    owner_name: githubRepo.owner.login,
    hourly_wage: 0,
    point_unit_price: 0,
    synced_at: new Date().toISOString(),
  };

  try {
    const rows = await supabaseFetch(
      "/rest/v1/repositories?select=id,github_repo_id,repo_name,owner_name,full_name,hourly_wage,point_unit_price,synced_at,created_at",
      {
        method: "POST",
        accessToken,
        headers: {
          Prefer: "return=representation",
        },
        body: payload,
      },
    );
    return Array.isArray(rows) ? rows[0] : rows;
  } catch (error) {
    if (error.status === 409) {
      throw apiError(409, "repository_already_registered", "このリポジトリは既に登録されています。");
    }
    throw error;
  }
}

async function resolveSelectedGithubRepository(input, githubAccessToken) {
  if (input.githubRepoId) {
    const repositories = await listGithubRepositories(githubAccessToken);
    const selected = repositories.find((repo) => String(repo.id) === input.githubRepoId);

    if (!selected) {
      throw apiError(
        404,
        "repository_not_found",
        "選択したGitHubリポジトリが見つからないか、アクセス権がありません。",
      );
    }

    return selected;
  }

  return fetchGithubRepository(input.ownerName, input.repoName, githubAccessToken);
}

async function listGithubRepositories(githubAccessToken) {
  if (!githubAccessToken) {
    throw apiError(
      401,
      "github_token_missing",
      "GitHubリポジトリ一覧を取得できません。もう一度ログインしてください。",
    );
  }

  const repositories = [];

  for (let page = 1; page <= 10; page += 1) {
    const url = new URL("https://api.github.com/user/repos");
    url.searchParams.set("affiliation", "owner,collaborator,organization_member");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const pageItems = await githubFetch(url, githubAccessToken);
    if (!Array.isArray(pageItems)) {
      throw apiError(502, "github_request_failed", "GitHubリポジトリ一覧の取得に失敗しました。");
    }

    repositories.push(...pageItems);
    if (pageItems.length < 100) break;
  }

  return repositories;
}

async function fetchGithubRepository(ownerName, repoName, githubAccessToken) {
  return githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(ownerName)}/${encodeURIComponent(repoName)}`,
    githubAccessToken,
  );
}

async function fetchGithubFileContent(repository, filePath, githubAccessToken) {
  if (!githubAccessToken) {
    throw apiError(
      401,
      "github_token_missing",
      "GitHubファイルを取得できません。もう一度ログインしてください。",
    );
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(
    repository.owner_name,
  )}/${encodeURIComponent(repository.repo_name)}/contents/${encodeURIComponent(filePath)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "AgileLens",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${githubAccessToken}`,
  };
  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => null);

  if (response.status === 404) {
    throw apiError(404, "claude_not_found", "選択したリポジトリにCLAUDE.mdが見つかりません。");
  }

  if (!response.ok) {
    throw apiError(
      response.status === 401 || response.status === 403 ? response.status : 502,
      "github_file_request_failed",
      data?.message || "CLAUDE.mdの取得に失敗しました。",
    );
  }

  if (!data?.content || data.encoding !== "base64") {
    throw apiError(422, "claude_content_invalid", "CLAUDE.mdの内容を読み取れませんでした。");
  }

  return Buffer.from(data.content, "base64").toString("utf8");
}

async function githubFetch(url, githubAccessToken) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "AgileLens",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(githubAccessToken ? { Authorization: `Bearer ${githubAccessToken}` } : {}),
  };

  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => null);

  if (response.ok) {
    return data;
  }

  if (response.status === 404) {
    throw apiError(
      404,
      "repository_not_found",
      "GitHubリポジトリが見つからないか、アクセス権がありません。",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw apiError(
      response.status,
      "github_access_denied",
      data?.message || "GitHubリポジトリへのアクセス権を確認できませんでした。",
    );
  }

  throw apiError(
    502,
    "github_request_failed",
    data?.message || "GitHub APIリクエストに失敗しました。",
  );
}

function extractTasksFromClaudeMarkdown(markdown) {
  const withoutCodeBlocks = markdown.replace(/```[\s\S]*?```/g, "");
  const tasks = [];
  const seenDetails = new Set();
  const headingStack = [];

  withoutCodeBlocks.split(/\r?\n/).forEach((line) => {
    const heading = parseMarkdownHeading(line);
    if (heading) {
      headingStack[heading.level - 1] = heading;
      headingStack.length = heading.level;
      return;
    }

    const task = parseMarkdownTaskLine(line, headingStack);
    if (!task) return;

    const comparableDetail = normalizeComparableTask(task.description);
    if (seenDetails.has(comparableDetail)) return;

    seenDetails.add(comparableDetail);
    tasks.push(task);
  });

  return numberDuplicateTaskTitles(tasks.slice(0, 40));
}

function parseMarkdownHeading(line) {
  const match = line.match(/^(#{1,6})\s+(.+)$/);
  if (!match) return null;

  return {
    level: match[1].length,
    title: normalizeHeadingTitle(match[2], { keepNumber: false }),
    label: normalizeHeadingTitle(match[2], { keepNumber: true }),
  };
}

function normalizeHeadingTitle(value, options = {}) {
  const text = normalizeTaskDescription(value).replace(/^\d+(?:-\d+)*\.\s*/, "");
  const numberedText = normalizeTaskDescription(value)
    .replace(/^(\d+(?:-\d+)*)\.\s*/, "$1 ")
    .replace(/^(\d+(?:-\d+)*)\s+(.+)$/, "$1 $2");
  const sourceText = options.keepNumber ? numberedText : text;
  const withoutParentheses = sourceText.replace(/[（(][^）)]+[）)]/g, "").trim();
  const parenthesized = sourceText.match(/[（(]([^）)]+)[）)]/);

  if (options.keepNumber) {
    return withoutParentheses.replace(/画面$/, "");
  }

  if (parenthesized && (/^\/|^\[/.test(withoutParentheses) || withoutParentheses.length < 3)) {
    return parenthesized[1].replace(/画面$/, "");
  }

  return withoutParentheses.replace(/画面$/, "");
}

function makeTaskContextLabel(contextHeadings) {
  const preferredHeading =
    contextHeadings.find((heading) => /^\d+\s+/.test(heading.label)) ||
    contextHeadings[0] ||
    contextHeadings[contextHeadings.length - 1];

  if (!preferredHeading) return "CLAUDE";

  return preferredHeading.label
    .replace(/^(\d+(?:-\d+)*)\s+(.+)$/, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
}

function getFallbackTaskContext(description) {
  const rules = [
    [/ログイン|サインイン|画面|UI|サイドバー|ヘッダー|ボード|アナリティクス/i, "1 画面一覧"],
    [/テーブル|DB|RLS|index|UUID|updated_at|repositories|issues|sprints|users/i, "2 テーブル設計"],
    [/同期|GitHub|Issue|タスク生成|CLAUDE\.md|ステータス/i, "3 処理フロー"],
    [/PV|EV|AC|EVM|稼働時間|Story Point|単価|時給/i, "3 EVM算出"],
    [/ロール|権限|オーナー|コラボレーター/i, "4 権限"],
  ];
  const matched = rules.find(([pattern]) => pattern.test(description));
  return matched ? matched[1] : "CLAUDE";
}

function parseMarkdownTaskLine(line, headingStack) {
  const match = line.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/);
  if (!match) return null;

  const description = normalizeTaskDescription(match[1]);
  if (!isTaskCandidate(description)) return null;
  const contextHeadings = headingStack.filter(Boolean).slice(-3);
  const context = contextHeadings.map((heading) => heading.title).join(" ");
  const contextLabel = makeTaskContextLabel(contextHeadings);

  return {
    titleBase: makeContextTaskTitle(context, description),
    contextLabel,
    description,
    storyPoint: extractStoryPoint(match[1]),
  };
}

function numberDuplicateTaskTitles(tasks) {
  const counts = tasks.reduce((acc, task) => {
    acc.set(task.titleBase, (acc.get(task.titleBase) || 0) + 1);
    return acc;
  }, new Map());
  const indexes = new Map();

  return tasks.map((task) => {
    const nextIndex = (indexes.get(task.titleBase) || 0) + 1;
    indexes.set(task.titleBase, nextIndex);

    return {
      ...task,
      title: counts.get(task.titleBase) > 1 ? `${task.titleBase}${nextIndex}` : task.titleBase,
    };
  });
}

function normalizeTaskDescription(value) {
  let description = String(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  description = description.replace(/^[:：\-–—\s]+/, "").replace(/[。.\s]+$/, "");
  return description.length > 600 ? `${description.slice(0, 597)}...` : description;
}

function makeContextTaskTitle(context, description) {
  const detailRules = [
    [/サイドバー/i, "サイドバー"],
    [/ヘッダー/i, "ヘッダー"],
    [/GitHub.*OAuth|OAuth.*GitHub|ログイン|サインイン/i, "ログイン"],
    [/リポジトリ.*追加|追加.*リポジトリ|repository/i, "リポジトリ追加"],
    [/CLAUDE\.md|定義ファイル|タスク.*生成|生成.*タスク/i, "タスク生成"],
    [/手動.*追加|追加.*手動/i, "手動追加"],
    [/ステータス.*同期|同期.*ステータス|ラベル.*更新|ラベル.*反映/i, "状態同期"],
    [/ドラッグ|ドロップ|D&D/i, "D&D"],
    [/カード/i, "カード"],
    [/カンバン|ボード/i, "ボード"],
    [/スプリント.*切り替え|切り替え.*スプリント|ドロップダウン/i, "スプリント選択"],
    [/稼働時間|作業時間/i, "稼働入力"],
    [/EVM.*グラフ|グラフ.*EVM|推移グラフ|Recharts/i, "EVMグラフ"],
    [/サマリー|ベロシティ|予測完了/i, "サマリー"],
    [/時給|ポイント単価|Story Point|story point|sp:/i, "単価設定"],
    [/Milestone|マイルストーン/i, "マイルストーン"],
    [/UUID|gen_random_uuid/i, "UUID"],
    [/updated_at|更新日時|trigger/i, "更新日時"],
    [/GitHub.*同期|同期.*GitHub|synced_at/i, "GitHub同期"],
    [/labels|ラベル/i, "ラベル"],
    [/source|manual|claude/i, "ソース"],
    [/kanban_column|Backlog|In Progress|Done/i, "カンバン列"],
    [/\bstate\b|open|closed/i, "状態"],
    [/index|検索/i, "Index"],
    [/RLS|auth\.uid|所有データ/i, "RLS"],
    [/users|ユーザー管理|Supabase Auth/i, "ユーザー"],
    [/repositories|連携リポジトリ/i, "リポジトリ"],
    [/sprints|スプリント情報/i, "スプリント"],
    [/issues|タスク情報|Issue/i, "Issue"],
    [/evm_daily_snapshots|スナップショット/i, "EVM記録"],
    [/PV|Planned Value/i, "PV"],
    [/EV|Earned Value/i, "EV"],
    [/AC|Actual Cost/i, "AC"],
    [/Webhook|webhook|GitHub API/i, "GitHub連携"],
    [/権限|ロール|Permission|アクセス|コラボレーター|オーナー/i, "権限"],
  ];
  const contextRules = [
    [/共通レイアウト|Layout/i, "レイアウト"],
    [/ログイン/i, "ログイン"],
    [/アジャイルボード|board/i, "ボード"],
    [/EVMアナリティクス|analytics/i, "EVM"],
    [/テーブル|Database|Schema|DB/i, "DB"],
    [/タスク生成|同期フロー/i, "タスク同期"],
    [/EVM.*算出|アーンド/i, "EVM算出"],
    [/ロール|Permissions/i, "権限"],
  ];

  const matched = detailRules.find(([pattern]) => pattern.test(description));
  if (matched) return matched[1];

  const contextMatched = contextRules.find(([pattern]) => pattern.test(context));
  if (contextMatched) return contextMatched[1];

  return compactTitle(description);
}

function compactTitle(value) {
  return String(value)
    .replace(/\b(?:する|します|できる|可能とする|対応する|実装する|作成する|追加する)$/g, "")
    .replace(/[「」『』【】()[\]。、,.]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 14);
}

function isTaskCandidate(title) {
  if (!title || title.length < 6) return false;
  if (/^(UUID|RLS|MVP|PV|EV|AC)\b/.test(title)) return false;
  return /実装|作成|追加|配置|対応|同期|入力|表示|登録|読み込|生成|設計|確認|更新|管理|切り替え|可視化|算出|許可|有効/.test(
    title,
  );
}

function extractStoryPoint(value) {
  const match = String(value).match(/\b(?:sp|story\s*point|point|pt)\s*[:=]?\s*(\d{1,2})\b/i);
  if (!match) return 1;

  const point = Number(match[1]);
  return Number.isFinite(point) && point >= 0 ? Math.min(point, 13) : 1;
}

function normalizeComparableTask(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeRepositoryInput(body) {
  const githubRepoId = stringValue(body.github_repo_id).trim();
  const fullName = String(body.full_name || "").trim();

  if (githubRepoId) {
    if (!/^\d+$/.test(githubRepoId)) {
      throw apiError(400, "invalid_repository_id", "GitHubリポジトリの選択が不正です。");
    }

    return {
      githubRepoId,
      ownerName: "",
      repoName: "",
    };
  }

  const [ownerName, repoName, ...rest] = fullName.split("/");

  if (!ownerName || !repoName || rest.length > 0) {
    throw apiError(400, "invalid_repository_name", "リポジトリは owner/repo 形式で入力してください。");
  }

  if (!isSafeGitHubPathPart(ownerName) || !isSafeGitHubPathPart(repoName)) {
    throw apiError(400, "invalid_repository_name", "GitHubリポジトリ名の形式が不正です。");
  }

  return {
    githubRepoId: "",
    ownerName,
    repoName,
  };
}

function isSafeGitHubPathPart(value) {
  return /^[A-Za-z0-9_.-]+$/.test(value);
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

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > 1024 * 32) {
      throw apiError(413, "request_too_large", "Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw apiError(400, "invalid_json", "JSON body is invalid.");
  }
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function handleApiError(req, res, error) {
  if (error.status === 401) {
    clearSessionCookies(res, req);
  }

  const status = Number(error.status || 500);
  sendJson(res, status, {
    error: error.code || "request_failed",
    message: error.message || "Request failed.",
  });
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
