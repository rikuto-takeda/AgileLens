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
const defaultEstimatedHours = 0.5;
const manualEstimatedHoursLabel = "estimated-hours-manual";

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
const progressSignalCache = new Map();
const progressSignalCacheMs = 60 * 1000;

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

    const repositoryMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)$/);
    if (req.method === "DELETE" && repositoryMatch) {
      await handleDeleteRepository(req, res, decodeURIComponent(repositoryMatch[1]));
      return;
    }

    const repositorySettingsMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/settings$/);
    if (req.method === "PATCH" && repositorySettingsMatch) {
      await handleUpdateRepositorySettings(req, res, decodeURIComponent(repositorySettingsMatch[1]));
      return;
    }

    const evmMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/evm$/);
    if (req.method === "GET" && evmMatch) {
      await handleGetRepositoryEvm(req, res, decodeURIComponent(evmMatch[1]), url);
      return;
    }

    const evmHoursMatch = url.pathname.match(
      /^\/api\/repositories\/([^/]+)\/evm\/working-hours$/,
    );
    if (req.method === "POST" && evmHoursMatch) {
      await handleSaveWorkingHours(req, res, decodeURIComponent(evmHoursMatch[1]), url);
      return;
    }

    const issuesMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/issues$/);
    if (req.method === "GET" && issuesMatch) {
      await handleListIssues(req, res, decodeURIComponent(issuesMatch[1]));
      return;
    }
    if (req.method === "POST" && issuesMatch) {
      await handleCreateIssue(req, res, decodeURIComponent(issuesMatch[1]));
      return;
    }

    const issueMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/issues\/([^/]+)$/);
    if (req.method === "PATCH" && issueMatch) {
      await handleUpdateIssue(
        req,
        res,
        decodeURIComponent(issueMatch[1]),
        decodeURIComponent(issueMatch[2]),
      );
      return;
    }
    if (req.method === "DELETE" && issueMatch) {
      await handleDeleteIssue(
        req,
        res,
        decodeURIComponent(issueMatch[1]),
        decodeURIComponent(issueMatch[2]),
      );
      return;
    }

    const generateTasksMatch = url.pathname.match(
      /^\/api\/repositories\/([^/]+)\/generate-claude-tasks$/,
    );
    if (req.method === "POST" && generateTasksMatch) {
      await handleGenerateClaudeTasks(req, res, decodeURIComponent(generateTasksMatch[1]));
      return;
    }

    const syncProgressMatch = url.pathname.match(
      /^\/api\/repositories\/([^/]+)\/sync-progress$/,
    );
    if (req.method === "POST" && syncProgressMatch) {
      await handleSyncIssueProgress(req, res, decodeURIComponent(syncProgressMatch[1]));
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

async function handleDeleteRepository(req, res, repositoryId) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    const repository = await getRepositoryById(accessToken, repositoryId);
    await deleteRepository(accessToken, repositoryId);

    sendJson(res, 200, {
      repository,
      detached_only: true,
    });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleUpdateRepositorySettings(req, res, repositoryId) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    await getRepositoryById(accessToken, repositoryId);
    const input = normalizeRepositorySettingsInput(await readJsonBody(req));
    const repository = await updateRepositorySettings(accessToken, repositoryId, input);

    sendJson(res, 200, { repository });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleGetRepositoryEvm(req, res, repositoryId, url) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    const repository = await getRepositoryById(accessToken, repositoryId);
    const issues = await listIssues(accessToken, repositoryId);
    const sprint = await ensureRepositoryEvmSprint(accessToken, repository);
    let snapshots = await listEvmSnapshots(accessToken, sprint.id);
    snapshots = await saveTodayEvmSnapshot(accessToken, sprint.id, repository, sprint, issues, snapshots);
    const period = resolveEvmPeriod(repository, url.searchParams);
    const evm = buildRepositoryEvm(repository, sprint, issues, snapshots, period);

    sendJson(res, 200, {
      repository,
      sprint,
      evm,
    });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleSaveWorkingHours(req, res, repositoryId, url) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    const repository = await getRepositoryById(accessToken, repositoryId);
    const issues = await listIssues(accessToken, repositoryId);
    const sprint = await ensureRepositoryEvmSprint(accessToken, repository);
    const input = normalizeWorkingHoursInput(await readJsonBody(req));
    const hourlyWage = Number(repository.hourly_wage || 0);
    let snapshots = await listEvmSnapshots(accessToken, sprint.id);
    const changedSnapshots = [];

    for (const entry of input.entries) {
      const existingSnapshot = snapshots.find(
        (snapshot) => snapshot.recorded_date === entry.recordedDate,
      );
      const values = calculateEvmValuesForDate(
        repository,
        sprint,
        issues,
        entry.recordedDate,
      );
      const dailyActualCost = calculateDailyActualCost({ daily_working_hours: entry.hours }, hourlyWage);
      const snapshot = {
        sprint_id: sprint.id,
        recorded_date: entry.recordedDate,
        planned_value: values.plannedValue,
        earned_value: resolveEarnedValueForSnapshotWrite(
          entry.recordedDate,
          existingSnapshot,
          values.earnedValue,
          todayDate(),
        ),
        actual_cost: dailyActualCost,
        daily_working_hours: entry.hours,
      };

      snapshots = mergeEvmSnapshot(snapshots, snapshot);
      changedSnapshots.push(snapshot);
    }

    for (const snapshot of changedSnapshots) {
      const actualCost = calculateCumulativeActualCost(
        snapshots,
        snapshot.recorded_date,
        hourlyWage,
      );
      const savedSnapshot = await upsertEvmSnapshot(accessToken, sprint.id, {
        recordedDate: snapshot.recorded_date,
        plannedValue: snapshot.planned_value,
        earnedValue: snapshot.earned_value,
        actualCost,
        dailyWorkingHours: snapshot.daily_working_hours,
      });
      snapshots = mergeEvmSnapshot(snapshots, savedSnapshot);
    }

    snapshots = await saveTodayEvmSnapshot(accessToken, sprint.id, repository, sprint, issues, snapshots);
    const period = resolveEvmPeriod(repository, url.searchParams);
    const evm = buildRepositoryEvm(repository, sprint, issues, snapshots, period);

    sendJson(res, 200, {
      repository,
      sprint,
      evm,
    });
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

async function handleCreateIssue(req, res, repositoryId) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    await getRepositoryById(accessToken, repositoryId);
    const input = normalizeManualIssueInput(await readJsonBody(req));
    const issue = await createManualIssue(accessToken, repositoryId, input);

    sendJson(res, 201, { issue });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleUpdateIssue(req, res, repositoryId, issueId) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    await getRepositoryById(accessToken, repositoryId);
    const input = normalizeIssueUpdateInput(await readJsonBody(req));
    const issue = await updateIssue(accessToken, repositoryId, issueId, input);

    sendJson(res, 200, { issue });
  } catch (error) {
    handleApiError(req, res, error);
  }
}

async function handleDeleteIssue(req, res, repositoryId, issueId) {
  try {
    const { accessToken } = await getAuthenticatedContext(req, res);
    await getRepositoryById(accessToken, repositoryId);
    await deleteIssue(accessToken, repositoryId, issueId);

    sendJson(res, 200, { deleted: true, issue_id: issueId });
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

async function handleSyncIssueProgress(req, res, repositoryId) {
  try {
    const { accessToken, user } = await getAuthenticatedContext(req, res);
    const repository = await getRepositoryById(accessToken, repositoryId);
    const profile = await getPrivateUserProfile(accessToken, user);
    const currentIssues = await listIssues(accessToken, repositoryId);
    const syncResult = await syncIssuesProgressFromGithub(
      accessToken,
      repository,
      currentIssues,
      profile?.github_access_token,
    );
    const issues = await listIssues(accessToken, repositoryId);
    const claudeTasks = await getClaudeTasksForDisplay(repository, profile?.github_access_token);

    sendJson(res, 200, {
      updated_count: syncResult.updatedCount,
      matched_count: syncResult.matchedCount,
      synced_at: syncResult.syncedAt,
      issues: applyClaudeTaskDisplayTitles(issues, claudeTasks),
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

function repositorySelectColumns({ includeEvmPeriod = true } = {}) {
  const columns = [
    "id",
    "github_repo_id",
    "repo_name",
    "owner_name",
    "full_name",
    "hourly_wage",
  ];

  if (includeEvmPeriod) {
    columns.push("evm_display_start_date", "evm_display_end_date");
  }

  columns.push("synced_at", "created_at");
  return columns.join(",");
}

function normalizeRepositoryRow(repository) {
  if (!repository) return repository;
  return {
    evm_display_start_date: null,
    evm_display_end_date: null,
    ...repository,
  };
}

async function fetchRepositoryRows(pathForSelect, options = {}) {
  try {
    const rows = await supabaseFetch(pathForSelect(repositorySelectColumns()), options);
    return Array.isArray(rows) ? rows.map(normalizeRepositoryRow) : rows;
  } catch (error) {
    if (!isMissingRepositoryEvmPeriodColumn(error)) throw error;

    const rows = await supabaseFetch(
      pathForSelect(repositorySelectColumns({ includeEvmPeriod: false })),
      options,
    );
    return Array.isArray(rows) ? rows.map(normalizeRepositoryRow) : rows;
  }
}

function isMissingRepositoryEvmPeriodColumn(error) {
  const text = `${error.message || ""} ${JSON.stringify(error.data || {})}`;
  return /evm_display_(start|end)_date/.test(text);
}

function hasEvmPeriodSettings(input) {
  return (
    Object.prototype.hasOwnProperty.call(input, "evm_display_start_date") ||
    Object.prototype.hasOwnProperty.call(input, "evm_display_end_date")
  );
}

function missingEvmPeriodColumnsError() {
  return apiError(
    500,
    "evm_period_columns_missing",
    "EVM表示期間を保存するDBカラムがありません。Supabaseのマイグレーションを適用してください。",
  );
}

async function getRepositoryById(accessToken, repositoryId) {
  const rows = await fetchRepositoryRows(
    (select) =>
      `/rest/v1/repositories?id=eq.${encodeURIComponent(
        repositoryId,
      )}&select=${select}&limit=1`,
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
  const rows = await fetchRepositoryRows(
    (select) => `/rest/v1/repositories?select=${select}&order=created_at.asc`,
    {
      method: "GET",
      accessToken,
    },
  );
  return Array.isArray(rows) ? rows : [];
}

async function deleteRepository(accessToken, repositoryId) {
  await supabaseFetch(`/rest/v1/repositories?id=eq.${encodeURIComponent(repositoryId)}`, {
    method: "DELETE",
    accessToken,
    headers: {
      Prefer: "return=minimal",
    },
  });
}

async function updateRepositorySettings(accessToken, repositoryId, input) {
  const pathForSelect = (select) =>
    `/rest/v1/repositories?id=eq.${encodeURIComponent(repositoryId)}&select=${select}`;
  const options = {
    method: "PATCH",
    accessToken,
    headers: {
      Prefer: "return=representation",
    },
    body: input,
  };
  let rows;
  try {
    rows = await supabaseFetch(pathForSelect(repositorySelectColumns()), options);
  } catch (error) {
    if (!isMissingRepositoryEvmPeriodColumn(error)) throw error;
    if (hasEvmPeriodSettings(input)) throw missingEvmPeriodColumnsError();
    rows = await supabaseFetch(
      pathForSelect(repositorySelectColumns({ includeEvmPeriod: false })),
      options,
    );
  }
  const repository = Array.isArray(rows) ? rows[0] : rows;
  if (!repository) {
    throw apiError(404, "repository_not_found", "リポジトリが見つかりません。");
  }
  return normalizeRepositoryRow(repository);
}

async function ensureRepositoryEvmSprint(accessToken, repository) {
  const existing = await listRepositorySprints(accessToken, repository.id);
  if (existing.length > 0) {
    return existing[0];
  }

  const startDate = dateOnly(repository.created_at) || todayDate();
  const rows = await supabaseFetch(
    `/rest/v1/sprints?select=${sprintSelectColumns()}`,
    {
      method: "POST",
      accessToken,
      headers: {
        Prefer: "return=representation",
      },
      body: {
        repository_id: repository.id,
        title: "MVP EVM",
        start_date: startDate,
        due_on: addDays(startDate, 13),
        cycle_days: 14,
        state: "open",
      },
    },
  );

  return Array.isArray(rows) ? rows[0] : rows;
}

async function listRepositorySprints(accessToken, repositoryId) {
  const rows = await supabaseFetch(
    `/rest/v1/sprints?repository_id=eq.${encodeURIComponent(
      repositoryId,
    )}&select=${sprintSelectColumns()}&order=created_at.asc`,
    {
      method: "GET",
      accessToken,
    },
  );
  return Array.isArray(rows) ? rows : [];
}

function sprintSelectColumns() {
  return "id,repository_id,github_milestone_id,title,start_date,due_on,cycle_days,state,synced_at,created_at,updated_at";
}

async function listEvmSnapshots(accessToken, sprintId) {
  const rows = await supabaseFetch(
    `/rest/v1/evm_daily_snapshots?sprint_id=eq.${encodeURIComponent(
      sprintId,
    )}&select=id,sprint_id,recorded_date,planned_value,earned_value,actual_cost,daily_working_hours,created_at,updated_at&order=recorded_date.asc`,
    {
      method: "GET",
      accessToken,
    },
  );
  return Array.isArray(rows) ? rows : [];
}

async function upsertEvmSnapshot(accessToken, sprintId, input) {
  const rows = await supabaseFetch(
    "/rest/v1/evm_daily_snapshots?on_conflict=sprint_id,recorded_date&select=id,sprint_id,recorded_date,planned_value,earned_value,actual_cost,daily_working_hours,created_at,updated_at",
    {
      method: "POST",
      accessToken,
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: {
        sprint_id: sprintId,
        recorded_date: input.recordedDate,
        planned_value: input.plannedValue,
        earned_value: input.earnedValue,
        actual_cost: input.actualCost,
        daily_working_hours: input.dailyWorkingHours,
      },
    },
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

function buildRepositoryEvm(repository, sprint, issues, snapshots, period = {}) {
  const startDate = sprint.start_date || dateOnly(repository.created_at) || todayDate();
  const cycleDays = normalizePositiveInteger(sprint.cycle_days, 14);
  const dueDate = sprint.due_on || addDays(startDate, cycleDays - 1);
  const today = todayDate();
  const autoLatestDate = maxDate([
    today,
    dueDate,
    ...snapshots.map((snapshot) => snapshot.recorded_date),
    ...issues.map((issue) => dateOnly(issue.closed_at || issue.updated_at || issue.created_at)),
  ]);
  const latestDate = period.endDate || autoLatestDate;
  const rangeStart = period.startDate || clampRangeStart(startDate, latestDate, 60);
  const plannedStartDate = rangeStart;
  const plannedEndDate = latestDate;
  const totalEstimatedHours = sumEstimatedHours(issues);
  const completedEstimatedHours = sumEstimatedHours(issues.filter(isDoneIssue));
  const progressEstimatedHours = sumProgressEstimatedHours(issues);
  const progressRate = calculateOverallProgressRate(issues);
  const hourlyWage = Number(repository.hourly_wage || 0);
  const bac = Math.round(totalEstimatedHours * hourlyWage);
  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.recorded_date, snapshot]));
  let cumulativeActualCost = snapshots
    .filter((snapshot) => snapshot.recorded_date < rangeStart)
    .reduce(
      (total, snapshot) => total + calculateDailyActualCost(snapshot, hourlyWage),
      0,
    );

  const series = enumerateDates(rangeStart, latestDate).map((date) => {
    const snapshot = snapshotMap.get(date);
    const values = calculateEvmValuesForDate(repository, sprint, issues, date, {
      plannedStartDate,
      plannedEndDate,
    });
    const dailyWorkingHours = Number(snapshot?.daily_working_hours || 0);
    const dailyActualCost = calculateDailyActualCost(snapshot, hourlyWage);
    const previousActualCost = cumulativeActualCost;
    const actualCost = previousActualCost + dailyActualCost;
    cumulativeActualCost = actualCost;

    return {
      date,
      day: formatEvmDayLabel(date),
      pv: values.plannedValue,
      ev: resolveEarnedValueForDate(date, snapshot, values.earnedValue, today),
      ac: actualCost,
      previous_actual_cost: previousActualCost,
      completed_estimated_hours: sumCompletedEstimatedHoursForDate(issues, date),
      daily_working_hours: dailyWorkingHours,
      daily_actual_cost: dailyActualCost,
    };
  });

  const latest = series[series.length - 1] || {
    date: today,
    pv: 0,
    ev: 0,
    ac: 0,
    daily_working_hours: 0,
    daily_actual_cost: 0,
  };
  const summaryPoint =
    series.find((point) => point.date === today) ||
    series.slice().reverse().find((point) => point.date <= today) ||
    latest;
  const todaySnapshot = snapshotMap.get(today);

  return {
    series,
    summary: {
      total_estimated_hours: totalEstimatedHours,
      completed_estimated_hours: completedEstimatedHours,
      progress_estimated_hours: progressEstimatedHours,
      progress_rate: progressRate,
      bac,
      total_budget: bac,
      planned_value: summaryPoint.pv,
      earned_value: summaryPoint.ev,
      actual_cost: summaryPoint.ac,
      schedule_variance: summaryPoint.ev - summaryPoint.pv,
      cost_variance: summaryPoint.ev - summaryPoint.ac,
      spi: summaryPoint.pv === 0 ? 0 : summaryPoint.ev / summaryPoint.pv,
      cpi: summaryPoint.ac === 0 ? 0 : summaryPoint.ev / summaryPoint.ac,
      hourly_wage: hourlyWage,
      start_date: startDate,
      due_on: dueDate,
      display_start_date: rangeStart,
      display_end_date: latestDate,
    },
    today: {
      recorded_date: today,
      daily_working_hours: Number(todaySnapshot?.daily_working_hours || 0),
      actual_cost: calculateDailyActualCost(todaySnapshot, hourlyWage),
    },
  };
}

function calculateEvmValuesForDate(repository, sprint, issues, date, options = {}) {
  const startDate = options.plannedStartDate || sprint.start_date || dateOnly(repository.created_at) || todayDate();
  const cycleDays = normalizePositiveInteger(sprint.cycle_days, 14);
  const dueDate = sprint.due_on || addDays(startDate, cycleDays - 1);
  const plannedEndDate = options.plannedEndDate || dueDate;
  const plannedDurationDays = Math.max(0, daysBetween(startDate, plannedEndDate));
  const totalEstimatedHours = sumEstimatedHours(issues);
  const hourlyWage = Number(repository.hourly_wage || 0);
  const bac = Math.round(totalEstimatedHours * hourlyWage);
  const elapsedDays = Math.max(0, Math.min(daysBetween(startDate, date), plannedDurationDays));
  const progressRate = calculateOverallProgressRate(issues);

  return {
    plannedValue: plannedDurationDays === 0 ? bac : Math.round(bac * (elapsedDays / plannedDurationDays)),
    earnedValue: Math.round(bac * progressRate),
    progressRate,
  };
}

function mergeEvmSnapshot(snapshots, snapshot) {
  const index = snapshots.findIndex((item) => item.recorded_date === snapshot.recorded_date);
  if (index === -1) return [...snapshots, snapshot];

  const nextSnapshots = snapshots.slice();
  nextSnapshots[index] = {
    ...nextSnapshots[index],
    ...snapshot,
  };
  return nextSnapshots;
}

async function saveTodayEvmSnapshot(accessToken, sprintId, repository, sprint, issues, snapshots) {
  const today = todayDate();
  const hourlyWage = Number(repository.hourly_wage || 0);
  const existingSnapshot = snapshots.find((snapshot) => snapshot.recorded_date === today);
  const dailyWorkingHours = Number(existingSnapshot?.daily_working_hours || 0);
  const values = calculateEvmValuesForDate(repository, sprint, issues, today);
  const nextSnapshot = {
    sprint_id: sprintId,
    recorded_date: today,
    planned_value: values.plannedValue,
    earned_value: values.earnedValue,
    actual_cost: calculateDailyActualCost({ daily_working_hours: dailyWorkingHours }, hourlyWage),
    daily_working_hours: dailyWorkingHours,
  };
  const snapshotsWithToday = mergeEvmSnapshot(snapshots, nextSnapshot);
  const actualCost = calculateCumulativeActualCost(snapshotsWithToday, today, hourlyWage);
  const savedSnapshot = await upsertEvmSnapshot(accessToken, sprintId, {
    recordedDate: today,
    plannedValue: nextSnapshot.planned_value,
    earnedValue: nextSnapshot.earned_value,
    actualCost,
    dailyWorkingHours,
  });

  return mergeEvmSnapshot(snapshots, savedSnapshot);
}

function calculateCumulativeActualCost(snapshots, recordedDate, hourlyWage) {
  return calculatePreviousActualCost(snapshots, recordedDate, hourlyWage)
    + calculateDailyActualCost(snapshots.find((snapshot) => snapshot.recorded_date === recordedDate), hourlyWage);
}

function calculatePreviousActualCost(snapshots, recordedDate, hourlyWage) {
  return snapshots
    .filter((snapshot) => snapshot.recorded_date <= recordedDate)
    .reduce(
      (total, snapshot) => {
        if (snapshot.recorded_date === recordedDate) return total;
        return total + calculateDailyActualCost(snapshot, hourlyWage);
      },
      0,
    );
}

function calculateDailyActualCost(snapshot, hourlyWage) {
  return Math.round(Number(snapshot?.daily_working_hours || 0) * hourlyWage);
}

function resolveEarnedValueForDate(date, snapshot, currentEarnedValue, today) {
  if (date >= today) return currentEarnedValue;
  if (snapshot && !isBackfilledEvmSnapshot(date, snapshot)) {
    return Math.round(Number(snapshot.earned_value || 0));
  }
  return 0;
}

function resolveEarnedValueForSnapshotWrite(date, snapshot, currentEarnedValue, today) {
  if (date === today) return currentEarnedValue;
  if (snapshot && !isBackfilledEvmSnapshot(date, snapshot)) {
    return Math.round(Number(snapshot.earned_value || 0));
  }
  return 0;
}

function isBackfilledEvmSnapshot(date, snapshot) {
  const createdDate = dateOnly(snapshot.created_at);
  return Boolean(createdDate && date < createdDate);
}

function isDoneIssue(issue) {
  return issue.kanban_column === "Done" || issue.state === "closed";
}

function sumCompletedEstimatedHoursForDate(issues, date) {
  return issues.reduce((total, issue) => {
    if (!isDoneIssue(issue)) return total;
    const completedDate = dateOnly(issue.closed_at || issue.synced_at || issue.updated_at || issue.created_at);
    if (completedDate && completedDate > date) return total;
    return total + normalizeNonNegativeNumber(issue.estimated_hours);
  }, 0);
}

function sumEstimatedHours(issues) {
  return issues.reduce((total, issue) => total + normalizeNonNegativeNumber(issue.estimated_hours), 0);
}

function sumProgressEstimatedHours(issues) {
  return issues.reduce(
    (total, issue) => total + normalizeNonNegativeNumber(issue.estimated_hours) * issueProgressRate(issue),
    0,
  );
}

function calculateOverallProgressRate(issues) {
  const totalEstimatedHours = sumEstimatedHours(issues);
  if (totalEstimatedHours === 0) return 0;
  return sumProgressEstimatedHours(issues) / totalEstimatedHours;
}

function issueProgressRate(issue) {
  if (issue.kanban_column === "Done") return 1;
  if (issue.kanban_column === "In Progress") return 0.5;
  return 0;
}

function normalizeNonNegativeNumber(value) {
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function normalizePositiveInteger(value, fallbackValue) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallbackValue;
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  let cursor = startDate;
  while (cursor <= endDate && dates.length < 90) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function clampRangeStart(startDate, endDate, maxDays) {
  const minimumStart = addDays(endDate, -(maxDays - 1));
  return startDate < minimumStart ? minimumStart : startDate;
}

function maxDate(values) {
  return values.filter(Boolean).reduce((max, value) => (value > max ? value : max), todayDate());
}

function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateOnly(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : "";
  }
  return date.toISOString().slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatEvmDayLabel(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateText;
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
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
      estimated_hours: task.estimatedHours,
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

async function createManualIssue(accessToken, repositoryId, input) {
  try {
    const rows = await insertManualIssueRow(accessToken, repositoryId, input);
    return Array.isArray(rows) ? normalizeIssueRow(rows[0]) : normalizeIssueRow(rows);
  } catch (error) {
    if (!issueDescriptionColumnAvailable || !isMissingIssueDescriptionColumn(error)) {
      throw error;
    }

    issueDescriptionColumnAvailable = false;
    const rows = await insertManualIssueRow(accessToken, repositoryId, input);
    return Array.isArray(rows) ? normalizeIssueRow(rows[0]) : normalizeIssueRow(rows);
  }
}

async function insertManualIssueRow(accessToken, repositoryId, input) {
  const issue = {
    repository_id: repositoryId,
    title: input.title,
    state: "open",
    kanban_column: input.kanbanColumn,
    estimated_hours: input.estimatedHours,
    labels: [{ name: "manual-task" }],
    source: "manual",
    assignee_username: input.assigneeUsername,
  };

  if (issueDescriptionColumnAvailable) {
    issue.description = input.description;
  }

  return supabaseFetch(`/rest/v1/issues?select=${issueSelectColumns()}`, {
    method: "POST",
    accessToken,
    headers: {
      Prefer: "return=representation",
    },
    body: issue,
  });
}

async function updateIssue(accessToken, repositoryId, issueId, input) {
  try {
    const rows = await updateIssueRow(accessToken, repositoryId, issueId, input);
    const issue = Array.isArray(rows) ? rows[0] : rows;
    if (!issue) {
      throw apiError(404, "issue_not_found", "タスクが見つかりません。");
    }
    return normalizeIssueRow(issue);
  } catch (error) {
    if (!issueDescriptionColumnAvailable || !isMissingIssueDescriptionColumn(error)) {
      throw error;
    }

    issueDescriptionColumnAvailable = false;
    const rows = await updateIssueRow(accessToken, repositoryId, issueId, input);
    const issue = Array.isArray(rows) ? rows[0] : rows;
    if (!issue) {
      throw apiError(404, "issue_not_found", "タスクが見つかりません。");
    }
    return normalizeIssueRow(issue);
  }
}

async function updateIssueRow(accessToken, repositoryId, issueId, input) {
  const payload = {};

  if (input.kanbanColumn !== undefined) {
    payload.kanban_column = input.kanbanColumn;
    payload.state = input.kanbanColumn === "Done" ? "closed" : "open";
    payload.closed_at = input.kanbanColumn === "Done" ? new Date().toISOString() : null;
  }

  if (input.estimatedHours !== undefined) {
    payload.estimated_hours = input.estimatedHours;
    payload.labels = upsertIssueLabel(
      await getIssueLabels(accessToken, repositoryId, issueId),
      { name: manualEstimatedHoursLabel },
    );
  }

  return supabaseFetch(
    `/rest/v1/issues?id=eq.${encodeURIComponent(issueId)}&repository_id=eq.${encodeURIComponent(
      repositoryId,
    )}&select=${issueSelectColumns()}`,
    {
      method: "PATCH",
      accessToken,
      headers: {
        Prefer: "return=representation",
      },
      body: payload,
    },
  );
}

async function deleteIssue(accessToken, repositoryId, issueId) {
  const rows = await supabaseFetch(
    `/rest/v1/issues?id=eq.${encodeURIComponent(issueId)}&repository_id=eq.${encodeURIComponent(
      repositoryId,
    )}&select=id`,
    {
      method: "DELETE",
      accessToken,
      headers: {
        Prefer: "return=representation",
      },
    },
  );

  const deletedIssue = Array.isArray(rows) ? rows[0] : rows;
  if (!deletedIssue) {
    throw apiError(404, "issue_not_found", "タスクが見つかりません。");
  }

  return deletedIssue;
}

async function getIssueLabels(accessToken, repositoryId, issueId) {
  const rows = await supabaseFetch(
    `/rest/v1/issues?id=eq.${encodeURIComponent(issueId)}&repository_id=eq.${encodeURIComponent(
      repositoryId,
    )}&select=labels&limit=1`,
    {
      method: "GET",
      accessToken,
    },
  );
  const issue = Array.isArray(rows) ? rows[0] : rows;
  return Array.isArray(issue?.labels) ? issue.labels : [];
}

async function syncIssuesProgressFromGithub(accessToken, repository, issues, githubAccessToken) {
  if (!githubAccessToken) {
    throw apiError(
      401,
      "github_token_missing",
      "GitHubの進捗同期ができません。もう一度ログインしてください。",
    );
  }

  const syncedAt = new Date().toISOString();
  const signals = await fetchGithubProgressSignals(repository, githubAccessToken, syncedAt);
  const { updates, matchedCount } = buildIssueProgressUpdates(issues, signals);

  if (updates.length > 0) {
    await updateIssueProgressRows(accessToken, updates);
  }

  await updateRepositorySyncedAt(accessToken, repository.id, syncedAt);

  return {
    updatedCount: updates.length,
    matchedCount,
    syncedAt,
  };
}

async function fetchGithubProgressSignals(repository, githubAccessToken, syncedAt) {
  const cacheKey = `${repository.owner_name}/${repository.repo_name}`;
  const cached = progressSignalCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < progressSignalCacheMs) {
    return {
      syncedAt,
      ...cached.signals,
      closedIssueNumbers: new Set(cached.signals.closedIssues.map((issue) => Number(issue.number))),
    };
  }

  const githubRepository = await fetchGithubRepository(
    repository.owner_name,
    repository.repo_name,
    githubAccessToken,
  );
  const defaultBranch = githubRepository.default_branch || "main";
  const commitsBySha = new Map();
  const closedIssues = await fetchClosedGithubIssues(repository, githubAccessToken).catch(() => []);
  const branches = await fetchGithubBranches(repository, githubAccessToken).catch(() => [
    { name: defaultBranch },
  ]);
  const defaultCommits = await fetchGithubCommits(
    repository,
    defaultBranch,
    60,
    githubAccessToken,
  );

  defaultCommits.forEach((commit) => addProgressCommit(commitsBySha, commit, defaultBranch, true));

  const branchNames = branches
    .map((branch) => branch.name)
    .filter((branchName) => branchName && branchName !== defaultBranch)
    .slice(0, 8);

  for (const branchName of branchNames) {
    const branchCommits = await fetchGithubCommits(
      repository,
      branchName,
      12,
      githubAccessToken,
    ).catch(() => []);
    branchCommits.forEach((commit) => addProgressCommit(commitsBySha, commit, branchName, false));
  }

  await hydrateProgressCommitCode(repository, commitsBySha, githubAccessToken);

  const commits = Array.from(commitsBySha.values())
    .map((commit) => ({
      ...commit,
      branches: Array.from(commit.branches),
    }))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const signals = {
    syncedAt,
    defaultBranch,
    commits,
    closedIssues,
    closedIssueNumbers: new Set(closedIssues.map((issue) => Number(issue.number))),
  };

  progressSignalCache.set(cacheKey, {
    createdAt: Date.now(),
    signals: {
      defaultBranch,
      commits,
      closedIssues,
    },
  });

  return signals;
}

function addProgressCommit(commitsBySha, commit, branchName, onDefault) {
  if (!commit?.sha) return;

  const existing = commitsBySha.get(commit.sha);
  if (existing) {
    existing.onDefault = existing.onDefault || onDefault;
    existing.branches.add(branchName);
    return;
  }

  const message = commit.commit?.message || "";
  commitsBySha.set(commit.sha, {
    sha: commit.sha,
    message,
    searchText: normalizeSearchText(message),
    date: commit.commit?.committer?.date || commit.commit?.author?.date || "",
    htmlUrl: commit.html_url || "",
    codeSearchText: "",
    files: [],
    onDefault,
    branches: new Set([branchName]),
  });
}

async function hydrateProgressCommitCode(repository, commitsBySha, githubAccessToken) {
  const commits = Array.from(commitsBySha.values())
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 35);

  for (const commit of commits) {
    const detail = await fetchGithubCommitDetail(repository, commit.sha, githubAccessToken).catch(
      () => null,
    );
    if (!detail) continue;

    const files = Array.isArray(detail.files) ? detail.files : [];
    const codeFiles = files.filter((file) => isProgressCodePath(file.filename)).slice(0, 18);
    commit.files = codeFiles.map((file) => file.filename);
    commit.codeSearchText = normalizeSearchText(
      codeFiles
        .map((file) =>
          [
            file.filename,
            file.previous_filename,
            file.status,
            String(file.patch || "").slice(0, 24000),
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join("\n"),
    );
  }
}

async function fetchGithubCommitDetail(repository, sha, githubAccessToken) {
  return githubFetch(
    githubRepoEndpoint(repository, `commits/${encodeURIComponent(sha)}`),
    githubAccessToken,
  );
}

function isProgressCodePath(filePath) {
  const normalizedPath = String(filePath || "").replace(/\\/g, "/");
  const lowerPath = normalizedPath.toLowerCase();

  if (
    !normalizedPath ||
    lowerPath.includes("/node_modules/") ||
    lowerPath.includes("/dist/") ||
    lowerPath.includes("/build/") ||
    lowerPath.includes("/coverage/") ||
    lowerPath.includes("/.next/") ||
    lowerPath.includes("/.git/") ||
    lowerPath.endsWith("package-lock.json") ||
    lowerPath.endsWith("pnpm-lock.yaml") ||
    lowerPath.endsWith("yarn.lock") ||
    lowerPath.endsWith(".env") ||
    lowerPath.endsWith(".env.local") ||
    lowerPath.endsWith("claude.md") ||
    lowerPath.endsWith("readme.md")
  ) {
    return false;
  }

  return /\.(?:js|jsx|ts|tsx|mjs|cjs|html|css|scss|sql|json|yml|yaml|vue|svelte|py|go|rb|php|java|kt|swift|rs|cs)$/.test(
    lowerPath,
  );
}

async function fetchGithubBranches(repository, githubAccessToken) {
  const url = new URL(githubRepoEndpoint(repository, "branches"));
  url.searchParams.set("per_page", "100");

  const branches = await githubFetch(url, githubAccessToken);
  if (!Array.isArray(branches)) {
    throw apiError(502, "github_request_failed", "GitHubブランチ一覧の取得に失敗しました。");
  }

  return branches;
}

async function fetchGithubCommits(repository, branchName, perPage, githubAccessToken) {
  const url = new URL(githubRepoEndpoint(repository, "commits"));
  url.searchParams.set("sha", branchName);
  url.searchParams.set("per_page", String(perPage));

  const commits = await githubFetch(url, githubAccessToken);
  if (!Array.isArray(commits)) {
    throw apiError(502, "github_request_failed", "GitHubコミット一覧の取得に失敗しました。");
  }

  return commits;
}

async function fetchClosedGithubIssues(repository, githubAccessToken) {
  const url = new URL(githubRepoEndpoint(repository, "issues"));
  url.searchParams.set("state", "closed");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");

  const issues = await githubFetch(url, githubAccessToken);
  if (!Array.isArray(issues)) return [];

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title || "",
      body: issue.body || "",
      closedAt: issue.closed_at || "",
      searchText: normalizeSearchText(`${issue.title || ""} ${issue.body || ""}`),
    }));
}

function githubRepoEndpoint(repository, resourcePath) {
  return `https://api.github.com/repos/${encodeURIComponent(
    repository.owner_name,
  )}/${encodeURIComponent(repository.repo_name)}/${resourcePath}`;
}

function buildIssueProgressUpdates(issues, signals) {
  const updates = [];
  let matchedCount = 0;

  issues.forEach((issue) => {
    const decision = decideIssueProgress(issue, signals);
    if (!decision) return;

    matchedCount += 1;
    if (issue.kanban_column === "Done" && decision.kanbanColumn !== "Done") return;

    const nextState = decision.kanbanColumn === "Done" ? "closed" : "open";
    if (issue.kanban_column === decision.kanbanColumn && issue.state === nextState) return;

    updates.push({
      id: issue.id,
      kanban_column: decision.kanbanColumn,
      state: nextState,
      closed_at: decision.kanbanColumn === "Done" ? decision.closedAt || signals.syncedAt : undefined,
      synced_at: signals.syncedAt,
    });
  });

  return { updates, matchedCount };
}

function decideIssueProgress(issue, signals) {
  if (
    issue.github_issue_number &&
    signals.closedIssueNumbers.has(Number(issue.github_issue_number))
  ) {
    const closedIssue = signals.closedIssues.find(
      (item) => Number(item.number) === Number(issue.github_issue_number),
    );
    return {
      kanbanColumn: "Done",
      closedAt: closedIssue?.closedAt || signals.syncedAt,
    };
  }

  const matcher = createIssueProgressMatcher(issue);
  const matchedClosedIssue = signals.closedIssues.find((closedIssue) =>
    matcher.matches(closedIssue.searchText),
  );

  if (matchedClosedIssue) {
    return {
      kanbanColumn: "Done",
      closedAt: matchedClosedIssue.closedAt || signals.syncedAt,
    };
  }

  const messageMatchedCommits = signals.commits.filter((commit) => matcher.matches(commit.searchText));
  const codeMatchedCommits = signals.commits.filter((commit) =>
    matcher.matchesCode(commit.codeSearchText),
  );
  const matchedCommits = uniqueProgressCommits([...messageMatchedCommits, ...codeMatchedCommits]);
  const defaultMatchedCommit = matchedCommits.find((commit) => commit.onDefault);

  if (defaultMatchedCommit) {
    return {
      kanbanColumn: "Done",
      closedAt: defaultMatchedCommit.date || signals.syncedAt,
    };
  }

  if (matchedCommits.length > 0) {
    return {
      kanbanColumn: "In Progress",
    };
  }

  return null;
}

function uniqueProgressCommits(commits) {
  const seen = new Set();
  return commits.filter((commit) => {
    if (!commit?.sha || seen.has(commit.sha)) return false;
    seen.add(commit.sha);
    return true;
  });
}

function createIssueProgressMatcher(issue) {
  const sourceText = [
    issue.title,
    issue.description,
    issue.task_context,
    issue.github_issue_number ? `#${issue.github_issue_number}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const normalizedSource = normalizeSearchText(sourceText);
  const phrases = makeProgressPhrases(issue, normalizedSource);
  const terms = extractProgressTerms(normalizedSource);
  const codePhrases = makeProgressCodePhrases(issue, normalizedSource);

  return {
    matches(searchText) {
      if (!searchText) return false;
      if (issue.github_issue_number && searchText.includes(`#${issue.github_issue_number}`)) {
        return true;
      }

      let score = 0;
      let termMatches = 0;

      phrases.forEach((phrase) => {
        if (searchText.includes(phrase)) score += 8;
      });

      terms.forEach((term) => {
        if (searchText.includes(term.value)) {
          score += term.weight;
          termMatches += 1;
        }
      });

      return score >= 8 || (score >= 6 && termMatches >= 2);
    },
    matchesCode(searchText) {
      if (!searchText) return false;
      if (issue.github_issue_number && searchText.includes(`#${issue.github_issue_number}`)) {
        return true;
      }

      let score = 0;
      let hits = 0;

      codePhrases.forEach((phrase) => {
        if (searchText.includes(phrase.value)) {
          score += phrase.weight;
          hits += 1;
        }
      });

      terms.forEach((term) => {
        if (searchText.includes(term.value)) {
          score += Math.max(1, term.weight - 1);
          hits += 1;
        }
      });

      return score >= 10 || (score >= 7 && hits >= 2);
    },
  };
}

function makeProgressCodePhrases(issue, normalizedSource) {
  const phrases = new Map();
  const add = (value, weight = 4) => {
    const phrase = normalizeSearchText(value);
    if (!phrase || isWeakProgressPhrase(phrase)) return;
    phrases.set(phrase, Math.max(phrases.get(phrase) || 0, weight));
  };

  add(issue.title, 6);
  add(String(issue.title || "").replace(/\d+$/, ""), 6);
  add(issue.task_context, 4);

  const groups = [
    {
      patterns: [/ログイン|サインイン|oauth|auth/],
      phrases: [
        "authgithub",
        "handlegithubstart",
        "handleauthcallback",
        "supabaseauth",
        "githuboauth",
        "sessioncookies",
        "loginbusy",
      ],
    },
    {
      patterns: [/リポジトリ|repository|repo/],
      phrases: [
        "createrepository",
        "handlecreaterepository",
        "listrepositories",
        "githubrepoid",
        "availablegithubrepos",
        "repodialog",
        "repolist",
        "repositories",
      ],
    },
    {
      patterns: [/サイドバー|sidebar/],
      phrases: ["rendersidebar", "sidebar", "repolist", "selectedrepoid", "openrepodialog"],
    },
    {
      patterns: [/claude|タスク.*生成|生成.*タスク|定義ファイル/],
      phrases: [
        "generateclaudetasks",
        "handlegenerateclaudetasks",
        "extracttasksfromclaudemarkdown",
        "claudetask",
        "claudemd",
        "taskcontext",
      ],
    },
    {
      patterns: [/進捗|コミット|commit|プッシュ|push/],
      phrases: [
        "syncprogress",
        "syncissuesprogressfromgithub",
        "fetchgithubprogresssignals",
        "progresssync",
        "githubcommits",
        "closedissues",
      ],
    },
    {
      patterns: [/ステータス|状態|カンバン|kanban|ラベル|label/],
      phrases: ["kanbancolumn", "state", "labels", "githublabel", "contextbadge"],
    },
    {
      patterns: [/コミット|commit|プッシュ|push/],
      phrases: [
        "fetchgithubcommits",
        "fetchgithubcommitdetail",
        "codesearchtext",
        "commitsbysha",
        "branches",
        "push",
      ],
    },
    {
      patterns: [/ボード|カンバン|board|kanban/],
      phrases: ["renderboard", "issuecard", "cardlist", "kanbancolumn", "board", "column"],
    },
    {
      patterns: [/詳細|タップ|題名|単語|タイトル|title/],
      phrases: [
        "renderpointdialog",
        "taskdetail",
        "description",
        "dialogtasktitle",
        "selectedissueid",
        "maketaskcontexttitle",
      ],
    },
    {
      patterns: [/見積|工数|作業時間|estimated\s*hours/i],
      phrases: ["estimatedhours", "estimatepill", "estimatefield", "saveestimate"],
    },
    {
      patterns: [/ラベル|label/],
      phrases: ["labels", "githublabel", "kanbancolumn", "contextbadge"],
    },
    {
      patterns: [/スプリント|sprint|milestone|マイルストーン/],
      phrases: ["sprint", "rendersprintselect", "sprintsettings", "milestone", "selectedsprintid"],
    },
    {
      patterns: [/evm|pv|ev|ac|稼働|時給|見積/],
      phrases: [
        "renderanalytics",
        "evmdata",
        "plannedvalue",
        "earnedvalue",
        "actualcost",
        "hourlywage",
        "pointunitprice",
      ],
    },
    {
      patterns: [/db|テーブル|rls|database|schema/],
      phrases: [
        "createtable",
        "publicissues",
        "publicrepositories",
        "publicusers",
        "enablerowlevelsecurity",
        "createpolicy",
        "supabase",
      ],
    },
    {
      patterns: [/権限|permission|ロール|アクセス|コラボレーター|オーナー/],
      phrases: ["permission", "githubaccesstoken", "getprivateuserprofile", "rls", "access"],
    },
  ];

  groups.forEach((group) => {
    if (!group.patterns.some((pattern) => pattern.test(normalizedSource))) return;
    group.phrases.forEach((phrase) => add(phrase, 5));
  });

  return Array.from(phrases, ([value, weight]) => ({ value, weight }));
}

function makeProgressPhrases(issue, normalizedSource) {
  const phrases = new Set();
  [
    issue.title,
    String(issue.title || "").replace(/\d+$/, ""),
    issue.task_context,
  ].forEach((value) => addProgressPhrase(phrases, value));

  const groups = [
    {
      patterns: [/ログイン|サインイン|oauth/],
      phrases: ["ログイン", "サインイン", "oauth"],
    },
    {
      patterns: [/リポジトリ|repository|repo/, /追加|登録|選択/],
      phrases: ["リポジトリ追加", "リポジトリ登録", "repositoryadd"],
    },
    {
      patterns: [/状態|ステータス|進捗|カンバン|kanban/, /同期/],
      phrases: ["進捗同期", "ステータス同期", "状態同期", "カンバン同期"],
    },
    {
      patterns: [/コミット|commit/, /プッシュ|push|同期/],
      phrases: ["コミット同期", "プッシュ同期", "進捗同期"],
    },
    {
      patterns: [/claude|タスク/, /生成|同期/],
      phrases: ["claude", "タスク生成", "タスク同期"],
    },
    {
      patterns: [/サイドバー|sidebar/],
      phrases: ["サイドバー", "sidebar"],
    },
    {
      patterns: [/ボード|カンバン|board|kanban/],
      phrases: ["アジャイルボード", "カンバン", "board", "kanban"],
    },
    {
      patterns: [/evm|pv|ev|ac|稼働|時給|見積/],
      phrases: ["evm", "pv", "ev", "ac", "稼働時間", "時給", "見積時間"],
    },
  ];

  groups.forEach((group) => {
    if (group.patterns.every((pattern) => pattern.test(normalizedSource))) {
      group.phrases.forEach((phrase) => addProgressPhrase(phrases, phrase));
    }
  });

  return Array.from(phrases);
}

function addProgressPhrase(phrases, value) {
  const phrase = normalizeSearchText(value);
  if (!phrase || isWeakProgressPhrase(phrase)) return;
  if (phrase.length < 3 && !/^[a-z0-9]{2,}$/i.test(phrase)) return;
  phrases.add(phrase);
}

function isWeakProgressPhrase(value) {
  return new Set([
    "github",
    "issue",
    "タスク",
    "同期",
    "追加",
    "実装",
    "表示",
    "状態",
    "管理",
    "画面",
    "処理",
  ]).has(value);
}

function extractProgressTerms(normalizedSource) {
  const weightedTerms = [
    ["ログイン", 4],
    ["oauth", 4],
    ["サイドバー", 4],
    ["ヘッダー", 4],
    ["リポジトリ", 4],
    ["repository", 4],
    ["ボード", 3],
    ["カンバン", 3],
    ["kanban", 3],
    ["claude", 4],
    ["コミット", 4],
    ["commit", 4],
    ["プッシュ", 4],
    ["push", 4],
    ["進捗", 4],
    ["ステータス", 4],
    ["状態", 2],
    ["同期", 2],
    ["タスク", 2],
    ["生成", 3],
    ["詳細", 3],
    ["題名", 3],
    ["単語", 3],
    ["追加", 2],
    ["選択", 2],
    ["保存", 2],
    ["issue", 2],
    ["estimatedhours", 3],
    ["見積", 3],
    ["スプリント", 4],
    ["マイルストーン", 4],
    ["ラベル", 3],
    ["evm", 4],
    ["pv", 3],
    ["ac", 3],
    ["稼働", 3],
    ["時給", 3],
    ["権限", 4],
    ["rls", 4],
    ["db", 3],
    ["テーブル", 3],
    ["ユーザー", 3],
  ];

  const seen = new Set();
  return weightedTerms.reduce((terms, [rawValue, weight]) => {
    const value = normalizeSearchText(rawValue);
    if (!value || seen.has(value) || !normalizedSource.includes(value)) return terms;
    seen.add(value);
    terms.push({ value, weight });
    return terms;
  }, []);
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/#[0-9]+/g, (match) => match)
    .replace(/[の]/g, "")
    .replace(/[^a-z0-9#\u3040-\u30ff\u3400-\u9fff]+/g, "");
}

async function updateIssueProgressRows(accessToken, updates) {
  const rows = [];

  for (const update of updates) {
    const payload = {
      kanban_column: update.kanban_column,
      state: update.state,
      synced_at: update.synced_at,
    };

    if (update.closed_at !== undefined) {
      payload.closed_at = update.closed_at;
    }

    const updatedRows = await supabaseFetch(
      `/rest/v1/issues?id=eq.${encodeURIComponent(update.id)}&select=${issueSelectColumns()}`,
      {
        method: "PATCH",
        accessToken,
        headers: {
          Prefer: "return=representation",
        },
        body: payload,
      },
    );

    if (Array.isArray(updatedRows)) rows.push(...updatedRows.map(normalizeIssueRow));
  }

  return rows;
}

async function updateRepositorySyncedAt(accessToken, repositoryId, syncedAt) {
  await supabaseFetch(`/rest/v1/repositories?id=eq.${encodeURIComponent(repositoryId)}`, {
    method: "PATCH",
    accessToken,
    headers: {
      Prefer: "return=minimal",
    },
    body: {
      synced_at: syncedAt,
    },
  });
}

function issueSelectColumns() {
  const baseColumns =
    "id,repository_id,sprint_id,github_issue_id,github_issue_number,title,state,kanban_column,estimated_hours,source,assignee_username,assignee_avatar_url,github_html_url,labels,closed_at,synced_at,created_at,updated_at";
  return issueDescriptionColumnAvailable
    ? `id,repository_id,sprint_id,github_issue_id,github_issue_number,title,description,state,kanban_column,estimated_hours,source,assignee_username,assignee_avatar_url,github_html_url,labels,closed_at,synced_at,created_at,updated_at`
    : baseColumns;
}

function normalizeIssueRow(row) {
  const description =
    row.description || getIssueDescriptionFromLabels(row.labels) || (row.source === "claude" ? row.title : "");
  const estimatedHours = normalizeEstimatedHours(row.estimated_hours, { defaultValue: defaultEstimatedHours });

  return {
    ...row,
    description,
    estimated_hours:
      row.source === "claude" && !hasIssueLabel(row.labels, manualEstimatedHoursLabel)
        ? defaultEstimatedHours
        : estimatedHours,
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

function hasIssueLabel(labels, name) {
  return Array.isArray(labels) && labels.some((label) => label?.name === name);
}

function upsertIssueLabel(labels, nextLabel) {
  const safeLabels = Array.isArray(labels) ? labels.filter((label) => label && typeof label === "object") : [];
  if (hasIssueLabel(safeLabels, nextLabel.name)) return safeLabels;
  return [...safeLabels, nextLabel];
}

function isMissingIssueDescriptionColumn(error) {
  const text = `${error.message || ""} ${JSON.stringify(error.data || {})}`;
  return text.includes("description") && text.includes("issues");
}

async function findRepositoryByGithubId(accessToken, githubRepoId) {
  const rows = await fetchRepositoryRows(
    (select) =>
      `/rest/v1/repositories?github_repo_id=eq.${encodeURIComponent(
        String(githubRepoId),
      )}&select=${select}&limit=1`,
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
    synced_at: new Date().toISOString(),
  };

  try {
    const rows = await supabaseFetch(
      `/rest/v1/repositories?select=${repositorySelectColumns()}`,
      {
        method: "POST",
        accessToken,
        headers: {
          Prefer: "return=representation",
        },
        body: payload,
      },
    );
    return normalizeRepositoryRow(Array.isArray(rows) ? rows[0] : rows);
  } catch (error) {
    if (error.status === 409) {
      throw apiError(409, "repository_already_registered", "このリポジトリは既に登録されています。");
    }
    if (isMissingRepositoryEvmPeriodColumn(error)) {
      const rows = await supabaseFetch(
        `/rest/v1/repositories?select=${repositorySelectColumns({ includeEvmPeriod: false })}`,
        {
          method: "POST",
          accessToken,
          headers: {
            Prefer: "return=representation",
          },
          body: payload,
        },
      );
      return normalizeRepositoryRow(Array.isArray(rows) ? rows[0] : rows);
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
    [/PV|EV|AC|EVM|稼働時間|見積時間|作業時間|時給/i, "3 EVM算出"],
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
    estimatedHours: estimateTaskHours(description, context),
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
    [/時給|見積時間|工数|作業時間/i, "工数設定"],
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

function estimateTaskHours(description, context = "") {
  return defaultEstimatedHours;
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

function normalizeRepositorySettingsInput(body) {
  const input = {};

  if (body.hourly_wage !== undefined) {
    input.hourly_wage = normalizeMoneyInput(body.hourly_wage, "時給");
  }

  const hasStartDate = body.evm_display_start_date !== undefined;
  const hasEndDate = body.evm_display_end_date !== undefined;
  if (hasStartDate || hasEndDate) {
    const startDate = stringValue(body.evm_display_start_date).trim();
    const endDate = stringValue(body.evm_display_end_date).trim();

    validateEvmPeriodDates(startDate, endDate);
    input.evm_display_start_date = startDate;
    input.evm_display_end_date = endDate;
  }

  if (Object.keys(input).length === 0) {
    throw apiError(400, "empty_repository_settings", "更新する設定がありません。");
  }

  return input;
}

function normalizeWorkingHoursInput(body) {
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : [
        {
          recorded_date: body.recorded_date,
          hours: body.hours ?? body.daily_working_hours,
        },
      ];

  if (rawEntries.length === 0 || rawEntries.length > 90) {
    throw apiError(400, "invalid_working_hours_entries", "稼働時間は1日以上90日以内で保存してください。");
  }

  const entriesByDate = new Map();
  rawEntries.forEach((entry) => {
    const normalizedEntry = normalizeWorkingHoursEntry(entry);
    entriesByDate.set(normalizedEntry.recordedDate, normalizedEntry);
  });

  return {
    entries: Array.from(entriesByDate.values()).sort((a, b) =>
      a.recordedDate.localeCompare(b.recordedDate),
    ),
  };
}

function normalizeWorkingHoursEntry(entry) {
  const hours = Number(entry.hours ?? entry.daily_working_hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw apiError(400, "invalid_working_hours", "稼働時間は0以上24以下で入力してください。");
  }

  const recordedDate = stringValue(entry.recorded_date || todayDate()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordedDate)) {
    throw apiError(400, "invalid_recorded_date", "記録日の形式が不正です。");
  }

  return {
    hours: Math.round(hours * 100) / 100,
    recordedDate,
  };
}

function normalizeEvmPeriodInput(searchParams) {
  const startDate = stringValue(searchParams.get("start_date")).trim();
  const endDate = stringValue(searchParams.get("end_date")).trim();

  if (!startDate && !endDate) return {};
  validateEvmPeriodDates(startDate, endDate);

  return {
    startDate,
    endDate,
  };
}

function resolveEvmPeriod(repository, searchParams) {
  const requestedPeriod = normalizeEvmPeriodInput(searchParams);
  if (requestedPeriod.startDate && requestedPeriod.endDate) return requestedPeriod;

  const storedStartDate = stringValue(repository.evm_display_start_date).trim();
  const storedEndDate = stringValue(repository.evm_display_end_date).trim();
  if (!storedStartDate && !storedEndDate) return {};
  if (!isDateOnly(storedStartDate) || !isDateOnly(storedEndDate)) return {};
  if (storedStartDate > storedEndDate || daysBetween(storedStartDate, storedEndDate) > 89) return {};

  return {
    startDate: storedStartDate,
    endDate: storedEndDate,
  };
}

function validateEvmPeriodDates(startDate, endDate) {
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) {
    throw apiError(400, "invalid_evm_period", "EVM表示期間は開始日と終了日を指定してください。");
  }
  if (startDate > endDate) {
    throw apiError(400, "invalid_evm_period", "EVM表示期間の開始日は終了日以前にしてください。");
  }
  if (daysBetween(startDate, endDate) > 89) {
    throw apiError(400, "invalid_evm_period", "EVM表示期間は90日以内で指定してください。");
  }
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(stringValue(value));
}

function normalizeMoneyInput(value, label) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 0 || amount > 999999999) {
    throw apiError(400, "invalid_money_value", `${label}は0以上の整数で入力してください。`);
  }

  return amount;
}

function normalizeManualIssueInput(body) {
  const title = stringValue(body.title).trim();
  if (!title) {
    throw apiError(400, "invalid_issue_title", "タスク名を入力してください。");
  }

  return {
    title: title.slice(0, 240),
    description: stringValue(body.description || title).trim().slice(0, 1000),
    assigneeUsername: normalizeAssigneeUsername(body.assignee_username || body.assignee),
    estimatedHours: normalizeEstimatedHours(
      body.estimated_hours ?? body.estimatedHours,
      { defaultValue: defaultEstimatedHours },
    ),
    kanbanColumn: normalizeKanbanColumn(body.kanban_column || "Backlog"),
  };
}

function normalizeIssueUpdateInput(body) {
  const input = {};

  if (body.kanban_column !== undefined) {
    input.kanbanColumn = normalizeKanbanColumn(body.kanban_column);
  }

  if (body.estimated_hours !== undefined || body.estimatedHours !== undefined) {
    input.estimatedHours = normalizeEstimatedHours(
      body.estimated_hours ?? body.estimatedHours,
      { defaultValue: defaultEstimatedHours },
    );
  }

  if (Object.keys(input).length === 0) {
    throw apiError(400, "empty_issue_update", "更新するタスク情報がありません。");
  }

  return input;
}

function normalizeKanbanColumn(value) {
  const column = stringValue(value).trim();
  if (!["Backlog", "In Progress", "Done"].includes(column)) {
    throw apiError(400, "invalid_kanban_column", "カンバン列の指定が不正です。");
  }

  return column;
}

function normalizeEstimatedHours(value, options = {}) {
  const rawValue =
    value === undefined || value === null || value === "" ? options.defaultValue ?? defaultEstimatedHours : value;
  const hours = Number(rawValue);
  if (!Number.isFinite(hours) || hours < 0 || hours > 999) {
    throw apiError(400, "invalid_estimated_hours", "見積時間は0以上999以下で入力してください。");
  }

  return Math.round(hours * 4) / 4;
}

function normalizeAssigneeUsername(value) {
  const username = stringValue(value).trim();
  if (!username) return null;

  return username.slice(0, 32);
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
  if (error.status === 401 && !String(error.code || "").startsWith("github_")) {
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
