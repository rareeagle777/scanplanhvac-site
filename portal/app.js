// ScanPlanHVAC web portal — phase 1: sign in, browse projects, download exported reports.
//
// Projects are created and edited on the iPhone; this page only reads. The project payload in
// `projects.data` is the app's full Project JSON, so only the handful of top-level fields shown
// here are touched. Anything else is left exactly as the app wrote it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, PROJECTS_TABLE, REPORTS_BUCKET, WEATHER_BUCKET } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const views = ["view-signin", "view-recovery", "view-projects", "view-project"];

let projects = [];
let currentProject = null;

// MARK: - View switching

function show(viewId) {
    for (const id of views) $(id).classList.toggle("hidden", id !== viewId);
}

function setMessage(id, text, kind = "") {
    const el = $(id);
    el.textContent = text;
    el.className = `message ${kind}`.trim();
}

function showError(text) {
    const el = $("global-error");
    el.textContent = text ?? "";
    el.classList.toggle("hidden", !text);
}

// MARK: - Auth

async function refreshSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        $("account").classList.remove("hidden");
        $("account-email").textContent = session.user.email ?? "";
        await loadProjects();
        show("view-projects");
    } else {
        $("account").classList.add("hidden");
        show("view-signin");
    }
}

$("signin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    setMessage("signin-message", "Signing in…");
    const { error } = await supabase.auth.signInWithPassword({
        email: $("signin-email").value.trim(),
        password: $("signin-password").value,
    });
    button.disabled = false;
    if (error) {
        setMessage("signin-message", error.message, "error");
        return;
    }
    setMessage("signin-message", "");
    await refreshSession();
});

$("forgot").addEventListener("click", async () => {
    const email = $("signin-email").value.trim();
    if (!email) {
        setMessage("signin-message", "Enter your email above first.", "error");
        return;
    }
    // The link returns to this page; supabase-js picks the recovery token out of the URL and
    // fires PASSWORD_RECOVERY below.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
    });
    setMessage("signin-message",
        error ? error.message : "Check your email for a reset link.",
        error ? "error" : "success");
});

$("recovery-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("recovery-password").value;
    if (password !== $("recovery-confirm").value) {
        setMessage("recovery-message", "Passwords don't match.", "error");
        return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
        setMessage("recovery-message", error.message, "error");
        return;
    }
    setMessage("recovery-message", "Password updated.", "success");
    setTimeout(refreshSession, 800);
});

$("sign-out").addEventListener("click", async () => {
    await supabase.auth.signOut();
    projects = [];
    currentProject = null;
    await refreshSession();
});

supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
        show("view-recovery");
    } else if (event === "SIGNED_OUT") {
        show("view-signin");
    }
});

// MARK: - Projects

async function loadProjects() {
    showError(null);
    // Only live rows; the app soft-deletes by stamping deleted_at.
    const { data, error } = await supabase
        .from(PROJECTS_TABLE)
        .select("id, name, updated_at, data")
        .is("deleted_at", null)
        .order("updated_at", { ascending: false });
    if (error) {
        showError(`Couldn't load projects: ${error.message}`);
        return;
    }
    projects = data ?? [];
    renderProjects();
}

function renderProjects() {
    const query = $("project-search").value.trim().toLowerCase();
    const list = $("project-list");
    list.innerHTML = "";
    const visible = projects.filter((p) => {
        if (!query) return true;
        const haystack = `${p.name ?? ""} ${p.data?.address ?? ""}`.toLowerCase();
        return haystack.includes(query);
    });
    $("projects-empty").classList.toggle("hidden", projects.length > 0);

    for (const project of visible) {
        const li = document.createElement("li");
        li.addEventListener("click", () => openProject(project));

        const text = document.createElement("div");
        const title = document.createElement("div");
        title.className = "project-title";
        title.textContent = project.name || "Untitled Project";
        const meta = document.createElement("div");
        meta.className = "project-meta";
        const rooms = project.data?.rooms?.length ?? 0;
        meta.textContent = [
            project.data?.address,
            `${rooms} room${rooms === 1 ? "" : "s"}`,
            `updated ${formatDate(project.updated_at)}`,
        ].filter(Boolean).join(" · ");
        text.append(title, meta);

        const chevron = document.createElement("span");
        chevron.className = "chevron";
        chevron.textContent = "›";
        li.append(text, chevron);
        list.append(li);
    }
}

$("project-search").addEventListener("input", renderProjects);
$("back").addEventListener("click", () => {
    currentProject = null;
    show("view-projects");
});

// MARK: - Project detail

async function openProject(project) {
    currentProject = project;
    const data = project.data ?? {};
    $("project-name").textContent = project.name || "Untitled Project";
    $("project-address").textContent = data.address ?? "";

    const facts = $("project-facts");
    facts.innerHTML = "";
    const rows = [
        ["Building type", data.buildingType],
        ["Rooms", data.rooms?.length ?? 0],
        ["Climate zone", data.climateZone != null ? `Zone ${data.climateZone}${(data.climateZoneMoistureRegime ?? "").toUpperCase()}` : null],
        ["Design conditions", designConditionsSummary(data)],
        ["Last updated", formatDate(project.updated_at)],
    ];
    for (const [label, value] of rows) {
        if (value == null || value === "") continue;
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = String(value);
        facts.append(dt, dd);
    }

    show("view-project");
    renderRooms(null);
    const [summary] = await Promise.all([loadSummary(), loadReports(), loadWeatherStatus()]);
    renderResults(summary);
    renderRooms(summary);
}

// MARK: - Load results & rooms

/// The app uploads `_summary.json` (results only) next to the project's reports on every sync.
async function loadSummary() {
    if (!currentProject) return null;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    const { data, error } = await supabase.storage.from(REPORTS_BUCKET)
        .download(`${session.user.id}/${currentProject.id}/_summary.json`);
    if (error || !data) return null;
    try {
        return JSON.parse(await data.text());
    } catch {
        return null;
    }
}

function renderResults(summary) {
    const facts = $("results-facts");
    facts.innerHTML = "";
    $("results-empty").classList.toggle("hidden", !!summary);
    if (!summary) return;
    const rows = [
        ["Heating load", `${formatNumber(summary.totalHeatingBTUh)} BTU/h`],
        ["Cooling load", `${formatNumber(summary.totalCoolingBTUh)} BTU/h (${summary.coolingTons} tons)`],
        ["Sensible / latent", `${formatNumber(summary.sensibleCoolingBTUh)} / ${formatNumber(summary.latentCoolingBTUh)} BTU/h`],
        ["Winter design temp", `${Math.round(summary.winterDesignTempF)}°F`],
        ["Summer design temp", `${Math.round(summary.summerDesignTempF)}°F`],
        ["Calculated", formatDate(summary.generatedAt)],
    ];
    for (const [label, value] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        facts.append(dt, dd);
    }
}

/// Room inputs straight from the synced project JSON. The app stores metres / square metres.
function renderRooms(summary) {
    const data = currentProject?.data ?? {};
    const rooms = data.rooms ?? [];
    const table = $("rooms-table");
    const body = table.querySelector("tbody");
    body.innerHTML = "";
    table.querySelector("tfoot")?.remove();
    $("rooms-empty").classList.toggle("hidden", rooms.length > 0);
    table.classList.toggle("hidden", rooms.length === 0);

    const floorNames = new Map((data.floorLevels ?? []).map((f) => [f.id, f.name]));
    let totalArea = 0;
    rooms.forEach((room, index) => {
        const areaSqFt = (room.floorArea ?? 0) * 10.7639;
        totalArea += areaSqFt;
        const result = summary?.rooms?.[index];
        const windows = (room.windows ?? []).reduce((n, w) => n + (w.quantity ?? 1), 0);
        const cells = [
            room.name || "Room",
            room.roomType ?? "",
            floorNames.get(room.floorLevelId) ?? "",
            formatNumber(areaSqFt),
            room.ceilingHeight ? (room.ceilingHeight * 3.28084).toFixed(1) : "",
            String(windows),
            String((room.doors ?? []).length),
            result ? formatNumber(result.heatingBTUh) : "—",
            result ? formatNumber(result.coolingBTUh) : "—",
        ];
        const tr = document.createElement("tr");
        cells.forEach((text, i) => {
            const td = document.createElement("td");
            if (i >= 3) td.className = "num";
            td.textContent = text;
            tr.append(td);
        });
        body.append(tr);
    });

    if (rooms.length > 0) {
        const tfoot = document.createElement("tfoot");
        const tr = document.createElement("tr");
        const totals = ["Total", "", "", formatNumber(totalArea), "", "", "",
            summary ? formatNumber(summary.totalHeatingBTUh) : "—",
            summary ? formatNumber(summary.totalCoolingBTUh) : "—"];
        totals.forEach((text, i) => {
            const td = document.createElement("td");
            if (i >= 3) td.className = "num";
            td.textContent = text;
            tr.append(td);
        });
        tfoot.append(tr);
        table.append(tfoot);
    }
}

function formatNumber(value) {
    if (value == null || Number.isNaN(value)) return "";
    return Math.round(value).toLocaleString();
}

/// Plain-language summary only — never the underlying method or constants.
function designConditionsSummary(data) {
    if (data.usesClimateZoneDesignConditions === false && (data.calculatedDesignConditions || data.derivedWinterDesignTemp != null)) {
        return "Calculated from the site's historical weather";
    }
    return "Climate zone estimate";
}

// MARK: - Reports

async function loadReports() {
    if (!currentProject) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const folder = `${session.user.id}/${currentProject.id}`;

    const list = $("report-list");
    list.innerHTML = "";
    const { data, error } = await supabase.storage.from(REPORTS_BUCKET).list(folder, {
        limit: 200,
        sortBy: { column: "updated_at", order: "desc" },
    });
    if (error) {
        showError(`Couldn't load reports: ${error.message}`);
        return;
    }
    const files = (data ?? []).filter((f) => f.id && f.name.toLowerCase().endsWith(".pdf"));
    $("reports-empty").classList.toggle("hidden", files.length > 0);

    for (const file of files) {
        const li = document.createElement("li");
        const text = document.createElement("div");
        const name = document.createElement("div");
        name.className = "report-name";
        name.textContent = reportTitle(file.name);
        const meta = document.createElement("div");
        meta.className = "report-meta";
        meta.textContent = [formatDate(file.updated_at ?? file.created_at), formatSize(file.metadata?.size)]
            .filter(Boolean).join(" · ");
        text.append(name, meta);

        const button = document.createElement("button");
        button.className = "download";
        button.textContent = "Download";
        button.addEventListener("click", () => downloadReport(`${folder}/${file.name}`, file.name, button));
        li.append(text, button);
        list.append(li);
    }
}

async function downloadReport(path, fileName, button) {
    button.disabled = true;
    button.textContent = "Preparing…";
    // Short-lived signed URL: the bucket is private and only the owner's session can mint one.
    const { data, error } = await supabase.storage.from(REPORTS_BUCKET).createSignedUrl(path, 300, { download: fileName });
    button.disabled = false;
    button.textContent = "Download";
    if (error) {
        showError(`Couldn't download report: ${error.message}`);
        return;
    }
    window.location.href = data.signedUrl;
}

$("refresh-reports").addEventListener("click", loadReports);

/// "Smith_Heat_Pump_Analysis.pdf" → "Heat Pump Analysis" when the project name is a prefix,
/// otherwise the whole name with underscores spaced out.
function reportTitle(fileName) {
    let base = fileName.replace(/\.pdf$/i, "");
    const projectName = (currentProject?.name ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    if (projectName && base.startsWith(projectName + "_")) base = base.slice(projectName.length + 1);
    // "HeatPump_System" → "Heat Pump System", "FloorPlans" → "Floor Plans" (but keep "HVAC", "CFM").
    return base.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

// MARK: - Weather

async function loadWeatherStatus() {
    const status = $("weather-status");
    const data = currentProject?.data ?? {};
    if (data.latitude == null || data.longitude == null) {
        status.textContent = "This project has no location yet. Set an address in the app to enable weather-based analysis.";
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    // The app names each hourly file by location (3-decimal degrees) and date range.
    const prefix = `hourly_v2_${data.latitude.toFixed(3)}_${data.longitude.toFixed(3)}_`;
    const { data: files, error } = await supabase.storage.from(WEATHER_BUCKET).list(session.user.id, {
        limit: 1000,
        search: prefix,
    });
    if (error) {
        status.textContent = "Weather data status unavailable.";
        return;
    }
    const count = (files ?? []).filter((f) => f.id && f.name.startsWith(prefix)).length;
    status.textContent = count > 0
        ? `${count} hourly weather range${count === 1 ? "" : "s"} uploaded from the app for this location. Energy analysis on the web will use these.`
        : "No weather data uploaded yet. In the app, open any energy analysis for this project (or re-save its address), then sync — the weather uploads automatically.";
}

// MARK: - Formatting

function formatDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// MARK: - Boot

refreshSession().catch((error) => showError(error.message));
