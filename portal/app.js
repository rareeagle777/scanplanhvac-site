// ScanPlanHVAC web portal — sign in, browse projects, review every analysis, download reports.
//
// Projects are created and edited on the iPhone; this page only reads. The project payload in
// `projects.data` is the app's full Project JSON; the phone also uploads `_analysis.json` (loads,
// energy, comfort — results and pre-binned chart data only) and `_summary.json` next to the
// project's reports. Nothing here recomputes a result.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, PROJECTS_TABLE, REPORTS_BUCKET, WEATHER_BUCKET } from "./config.js";
import { hBarChart, stackedHBarChart, columnChart, groupedColumnChart, lineChart, psychChart, palette, escape } from "./charts.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const views = ["view-signin", "view-recovery", "view-projects", "view-project"];
const TABS = ["overview", "loads", "energy", "comfort", "dhw", "intelligence", "reports"];

let projects = [];
let currentProject = null;
let currentAnalysis = null;
let currentSummary = null;

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

function showTab(name) {
    for (const t of TABS) $(`panel-${t}`).classList.toggle("hidden", t !== name);
    document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
}

document.querySelectorAll("#tabs .tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

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
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
    });
    setMessage("signin-message", error ? error.message : "Check your email for a reset link.", error ? "error" : "success");
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
    if (event === "PASSWORD_RECOVERY") show("view-recovery");
    else if (event === "SIGNED_OUT") show("view-signin");
});

async function userId() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user.id ?? null;
}

// MARK: - Projects

async function loadProjects() {
    showError(null);
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
    const visible = projects.filter((p) => !query || `${p.name ?? ""} ${p.data?.address ?? ""}`.toLowerCase().includes(query));
    $("projects-empty").classList.toggle("hidden", projects.length > 0);

    for (const project of visible) {
        const li = document.createElement("li");
        li.addEventListener("click", () => openProject(project));
        const rooms = project.data?.rooms?.length ?? 0;
        li.innerHTML = `<div><div class="project-title">${escape(project.name || "Untitled Project")}</div>
            <div class="project-meta">${escape([project.data?.address, `${rooms} room${rooms === 1 ? "" : "s"}`, `updated ${formatDate(project.updated_at)}`].filter(Boolean).join(" · "))}</div></div>
            <span class="chevron">›</span>`;
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
    currentAnalysis = null;
    currentSummary = null;
    const data = project.data ?? {};
    $("project-name").textContent = project.name || "Untitled Project";
    $("project-address").textContent = data.address ?? "";
    renderFacts($("project-facts"), [
        ["Building type", data.buildingType],
        ["Rooms", data.rooms?.length ?? 0],
        ["Climate zone", data.climateZone != null ? `Zone ${data.climateZone}${(data.climateZoneMoistureRegime ?? "").toUpperCase()}` : null],
        ["Design conditions", designConditionsSummary(data)],
        ["Last updated", formatDate(project.updated_at)],
    ]);

    for (const t of TABS) if (t !== "reports") $(`panel-${t}`).innerHTML = `<div class="card"><p class="empty-note">Loading…</p></div>`;
    $("analysis-status").textContent = "";
    show("view-project");
    showTab("overview");

    const [summary, analysis] = await Promise.all([
        downloadJSON(`_summary.json`), downloadJSON(`_analysis.json`), loadReports(), loadWeatherStatus(),
    ]);
    currentSummary = summary;
    currentAnalysis = analysis;
    if (analysis?.generatedAt) {
        $("analysis-status").textContent = `Analysis last updated from the app ${formatDate(analysis.generatedAt)}.`;
    } else {
        $("analysis-status").textContent = "The app hasn't uploaded this project's analysis yet. Open the app and let it sync.";
    }
    renderOverview();
    renderLoads();
    renderEnergy();
    renderComfort();
    renderDHW();
    renderIntelligence();
}

async function downloadJSON(name) {
    const uid = await userId();
    if (!uid || !currentProject) return null;
    const { data, error } = await supabase.storage.from(REPORTS_BUCKET).download(`${uid}/${currentProject.id}/${name}`);
    if (error || !data) return null;
    try { return JSON.parse(await data.text()); } catch { return null; }
}

// MARK: - Overview

function renderOverview() {
    const panel = $("panel-overview");
    panel.innerHTML = "";
    const loads = currentAnalysis?.loads;
    const s = currentSummary;

    const results = card(panel, "Load results");
    if (loads) {
        tiles(results, [
            ["Heating load", `${num(loads.heating.totalBTUh)} BTU/h`, `Recommended ${num(loads.heating.recommendedCapacityBTUh)} BTU/h`],
            ["Cooling load", `${num(loads.cooling.totalBTUh)} BTU/h`, `${loads.cooling.recommendedTons} tons recommended`],
            ["Sensible / latent", `${num(loads.cooling.sensibleBTUh)} / ${num(loads.cooling.latentBTUh)}`, `SHR ${loads.cooling.sensibleHeatRatio}`],
            ["Design temperatures", `${Math.round(loads.design.winterOutdoorF)}°F / ${Math.round(loads.design.summerOutdoorF)}°F`, loads.design.isSiteDerived ? "From the site's historical weather" : "Climate zone estimate"],
        ]);
    } else if (s) {
        tiles(results, [
            ["Heating load", `${num(s.totalHeatingBTUh)} BTU/h`],
            ["Cooling load", `${num(s.totalCoolingBTUh)} BTU/h`, `${s.coolingTons} tons`],
            ["Design temperatures", `${Math.round(s.winterDesignTempF)}°F / ${Math.round(s.summerDesignTempF)}°F`],
        ]);
    } else {
        note(results, "Load results appear here after the project syncs from the app.");
    }

    const roomsCard = card(panel, "Rooms");
    renderRoomsTable(roomsCard);
}

/// Room inputs straight from the synced project JSON (metres / square metres), plus loads.
function renderRoomsTable(container) {
    const data = currentProject?.data ?? {};
    const rooms = data.rooms ?? [];
    if (!rooms.length) { note(container, "This project has no rooms yet."); return; }
    const floorNames = new Map((data.floorLevels ?? []).map((f) => [f.id, f.name]));
    const heat = currentAnalysis?.loads?.heating.rooms ?? [];
    const cool = currentAnalysis?.loads?.cooling.rooms ?? [];
    const summaryRooms = currentSummary?.rooms ?? [];
    let totalArea = 0;
    const rows = rooms.map((room, i) => {
        const area = (room.floorArea ?? 0) * 10.7639;
        totalArea += area;
        const h = heat[i]?.totalBTUh ?? summaryRooms[i]?.heatingBTUh;
        const c = cool[i]?.totalBTUh ?? summaryRooms[i]?.coolingBTUh;
        return [room.name || "Room", room.roomType ?? "", floorNames.get(room.floorLevelId) ?? "",
            num(area), room.ceilingHeight ? (room.ceilingHeight * 3.28084).toFixed(1) : "",
            String((room.windows ?? []).reduce((n, w) => n + (w.quantity ?? 1), 0)), String((room.doors ?? []).length),
            h != null ? num(h) : "—", c != null ? num(c) : "—"];
    });
    const th = currentAnalysis?.loads?.heating.totalBTUh ?? currentSummary?.totalHeatingBTUh;
    const tc = currentAnalysis?.loads?.cooling.totalBTUh ?? currentSummary?.totalCoolingBTUh;
    table(container, ["Room", "Type", "Floor", "Area (sq ft)", "Ceiling (ft)", "Windows", "Doors", "Heating (BTU/h)", "Cooling (BTU/h)"], rows,
        { numericFrom: 3, footer: ["Total", "", "", num(totalArea), "", "", "", th != null ? num(th) : "—", tc != null ? num(tc) : "—"] });
}

// MARK: - HVAC Loads

const HEATING_COMPONENTS = ["Walls", "Windows", "Doors", "Skylights", "Ceiling", "Floor", "Infiltration", "Ventilation"];

function renderLoads() {
    const panel = $("panel-loads");
    panel.innerHTML = "";
    const loads = currentAnalysis?.loads;
    if (!loads) { note(card(panel, "HVAC Load Analysis"), "Load analysis appears here after the app syncs this project."); return; }

    const design = card(panel, "Design conditions");
    tiles(design, [
        ["Winter design", `${Math.round(loads.design.winterOutdoorF)}°F outdoor`, `${Math.round(loads.design.winterIndoorF)}°F indoor · ΔT ${Math.round(loads.design.winterIndoorF - loads.design.winterOutdoorF)}°F`],
        ["Summer design", `${Math.round(loads.design.summerOutdoorF)}°F outdoor`, `${Math.round(loads.design.summerIndoorF)}°F indoor · ${loads.design.climateType} climate`],
        ["Outdoor humidity", `${Math.round(loads.design.outdoorGrains)} gr/lb`, `Indoor ${Math.round(loads.design.indoorGrains)} gr/lb · Δ ${Math.round(loads.design.outdoorGrains - loads.design.indoorGrains)}`],
        ["Elevation", `${num(loads.design.elevationFt)} ft`, `Daily range ${Math.round(loads.design.dailyRangeF)}°F`],
    ]);
    note(design, loads.design.isSiteDerived ? "Design temperatures are calculated from this site's historical weather." : "Design temperatures are the climate zone estimate.");

    // Heating
    const h = loads.heating;
    const heating = card(panel, "Heating");
    tiles(heating, [
        ["Total heat loss", `${num(h.totalBTUh)} BTU/h`],
        ["Recommended capacity", `${num(h.recommendedCapacityBTUh)} BTU/h`, "Includes a sizing margin"],
        ["Heat pump airflow", `${num(h.heatPumpCFM)} CFM`],
        ["Furnace airflow", `${num(h.furnaceCFM)} CFM`],
    ]);
    const hasEntered = h.rooms.some((r) => r.isOverride);
    chartBlock(heating, "Heat loss by room", "Stacked by building component. Rooms with an entered load show as a single bar. Hover a segment for its value.", (el) =>
        stackedHBarChart(el, {
            rows: sortedRooms(h.rooms).map((r) => ({ label: roomLabel(r), segments: r.isOverride ? [{ name: "Entered total", value: r.totalBTUh }] : r.components })),
            series: hasEntered ? [...HEATING_COMPONENTS, "Entered total"] : HEATING_COMPONENTS, format: (v) => `${num(v)} BTU/h`,
        }));
    chartBlock(heating, "Heat loss by component", "Whole building.", (el) =>
        hBarChart(el, { rows: componentTotals(h.rooms).map(([name, value]) => ({ label: name, value })), format: (v) => `${num(v)} BTU/h` }));
    table(heating, ["Room", "Floor", "Heat loss (BTU/h)", "% of total"],
        sortedRooms(h.rooms).map((r) => [r.name + (r.isOverride ? " (entered)" : ""), r.floor ?? "", num(r.totalBTUh), pct(r.totalBTUh / Math.max(1, h.totalBTUh))]), { numericFrom: 2 });

    // Cooling
    const c = loads.cooling;
    const cooling = card(panel, "Cooling");
    tiles(cooling, [
        ["Total cooling load", `${num(c.totalBTUh)} BTU/h`, `${c.recommendedTons} tons recommended`],
        ["Sensible / latent", `${num(c.sensibleBTUh)} / ${num(c.latentBTUh)}`, `SHR ${c.sensibleHeatRatio}`],
        ["Airflow", `${num(c.requiredCFM)} CFM`, `${num(c.cfmPerTon)} CFM/ton · enthalpy basis ${num(c.enthalpyBasedCFM)} CFM`],
        ["Leaving air", `${c.leavingAirTemperatureF}°F`, `Recommended ${num(c.recommendedCapacityBTUh)} BTU/h`],
    ]);
    chartBlock(cooling, "Cooling load by room", "Sensible and latent portions.", (el) =>
        stackedHBarChart(el, {
            rows: sortedRooms(c.rooms).map((r) => ({ label: roomLabel(r), segments: [{ name: "Sensible", value: r.sensibleBTUh }, { name: "Latent", value: r.latentBTUh }] })),
            series: ["Sensible", "Latent"], format: (v) => `${num(v)} BTU/h`,
        }));
    chartBlock(cooling, "Cooling load by component", "Whole building; the largest contributors first.", (el) =>
        hBarChart(el, { rows: componentTotals(c.rooms).filter(([, v]) => v > 0).slice(0, 12).map(([name, value]) => ({ label: name, value })), format: (v) => `${num(v)} BTU/h` }));
    table(cooling, ["Room", "Floor", "Sensible", "Latent", "Total (BTU/h)", "% of total"],
        sortedRooms(c.rooms).map((r) => [r.name + (r.isOverride ? " (entered)" : ""), r.floor ?? "", num(r.sensibleBTUh), num(r.latentBTUh), num(r.totalBTUh), pct(r.totalBTUh / Math.max(1, c.totalBTUh))]), { numericFrom: 2 });
}

function sortedRooms(rooms) { return [...rooms].sort((a, b) => b.totalBTUh - a.totalBTUh); }
function roomLabel(r) { return r.floor ? `${r.name} (${r.floor})` : r.name; }
function componentTotals(rooms) {
    const totals = new Map();
    for (const r of rooms) if (!r.isOverride) for (const c of r.components) totals.set(c.name, (totals.get(c.name) ?? 0) + c.btuh);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

// MARK: - Energy Analysis

const FUEL_UNITS = { "Electricity": "kWh", "Natural Gas": "therms", "Heating Oil (#2)": "gallons", "Propane": "gallons" };

function renderEnergy() {
    const panel = $("panel-energy");
    panel.innerHTML = "";
    const e = currentAnalysis?.energy;
    const settings = currentProject?.data?.energyAnalysisSettings;
    if (!e) {
        note(card(panel, "Energy Cost Comparison"), settings
            ? "This project's energy analysis is set up, but its weather hasn't been uploaded yet. Open the project in the app and let it sync."
            : "Open Energy Analysis for this project in the app once; the comparison then appears here after each sync.");
        return;
    }
    const results = [...e.equipmentResults].sort((a, b) => (b.isBaseline ? 1 : 0) - (a.isBaseline ? 1 : 0) || a.seasonOperatingCost - b.seasonOperatingCost);
    const baseline = results.find((r) => r.isBaseline);

    const season = card(panel, "Season summary");
    tiles(season, [
        ["Period", `${shortDate(e.input.startDate)} – ${shortDate(e.input.endDate)}`],
        ["Heating demand", `${num(e.seasonTotalBTU / 1000)} kBTU`, `${num(e.totalHeatingHours)} heating hours`],
        ["Average outdoor", `${Math.round(e.seasonAvgOutdoorTempF)}°F`, `Indoor setpoint ${Math.round(e.input.indoorSetpoint)}°F`],
        ["Existing system", shortSystem(e.input.existingSystemType), baseline ? `${money(baseline.seasonOperatingCost)} for the season` : ""],
    ]);

    const cost = card(panel, "Cost comparison");
    chartBlock(cost, "Season operating cost by system", "The existing system is shown in orange.", (el) =>
        hBarChart(el, {
            rows: results.map((r) => ({ label: shortSystem(r.equipmentType) + (r.unitCount > 1 ? ` ×${r.unitCount}` : ""), value: r.seasonOperatingCost, color: r.isBaseline ? palette.series[1] : palette.series[0], note: r.isBaseline ? "Existing system" : (r.savingsVsBaseline >= 0 ? `Saves ${money(r.savingsVsBaseline)}` : `Costs ${money(-r.savingsVsBaseline)} more`) })),
            format: money,
        }));
    table(cost, ["System", "Fuel use", "Season cost", "Savings vs existing", "Unmet"],
        results.map((r) => [shortSystem(r.equipmentType) + (r.isBaseline ? " (existing)" : "") + (r.unitCount > 1 ? ` ×${r.unitCount}` : ""),
            `${num(r.seasonFuelConsumed)} ${FUEL_UNITS[r.fuelType] ?? ""}`, money(r.seasonOperatingCost),
            r.isBaseline ? "—" : `${money(r.savingsVsBaseline)} (${Math.round(r.savingsPercentage)}%)`,
            r.seasonUnmetHours > 0 ? `${num(r.seasonUnmetHours)} h` : "None"]), { numericFrom: 1 });

    const monthly = card(panel, "Monthly operating cost");
    const months = results[0]?.monthlyResults ?? [];
    const categories = months.map((m) => monthLabel(m.year, m.month));
    chartBlock(monthly, "Cost per month", "One line per system; hover a month for every system's cost.", (el) =>
        lineChart(el, { categories, series: results.map((r) => ({ name: shortSystem(r.equipmentType), values: r.monthlyResults.map((m) => m.operatingCost) })), format: money, yLabel: "$ per month" }));
    table(monthly, ["Month", ...results.map((r) => shortSystem(r.equipmentType))],
        months.map((m, i) => [categories[i], ...results.map((r) => money(r.monthlyResults[i]?.operatingCost ?? 0))]), { numericFrom: 1 });
}

function shortSystem(raw) {
    return String(raw ?? "").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

// MARK: - Comfort Performance

function renderComfort() {
    const panel = $("panel-comfort");
    panel.innerHTML = "";
    const c = currentAnalysis?.comfort;
    const hasUnits = (currentProject?.data?.heatPumpZones ?? []).some((z) => z.selectedOutdoorUnit);
    if (!c) {
        note(card(panel, "Comfort Performance"), hasUnits
            ? "The two years of weather this analysis needs haven't been uploaded yet. Open the project in the app and let it sync."
            : "Select an outdoor unit in the Heat Pump Sizer in the app to see its comfort performance here.");
        return;
    }
    const intro = card(panel, "Comfort Performance");
    note(intro, `Hour-by-hour simulation over ${shortDate(c.weatherStart)} – ${shortDate(c.weatherEnd)} at ${Math.round(c.heatingSetpointF)}°F heating and ${Math.round(c.coolingSetpointF)}°F cooling setpoints, ±${c.toleranceF}°F comfort band.`);

    for (const z of c.zones) {
        const zc = card(panel, z.name ? `${z.name} · ${z.unitModel}` : z.unitModel);
        const d = z.dehumidification;
        const verdictLabel = { good: "Keeps rooms dry", borderline: "Borderline humidity", poor: "Struggles to dehumidify" }[d.verdict] ?? d.verdict;
        const verdictIcon = { good: "✓", borderline: "!", poor: "✕" }[d.verdict] ?? "";
        zc.insertAdjacentHTML("beforeend", `<p><span class="verdict ${escape(d.verdict)}">${verdictIcon} ${escape(verdictLabel)}</span></p>`);
        const dehum = [`${Math.round(d.dryHoursPercent)}% of cooling hours stay under 60% indoor humidity.`];
        if (d.shortCyclePercent >= 1) dehum.push(`${Math.round(d.shortCyclePercent)}% of cooling hours run below the unit's ${num(d.minimumCapacityBTUh)} BTU/h minimum output, so it short-cycles.`);
        if (d.minimumExceedsLoad) dehum.push(`The unit's minimum output (${num(d.minimumCapacityBTUh)} BTU/h) is above the design cooling load (${num(d.designCoolingLoadBTUh)} BTU/h).`);
        note(zc, dehum.join(" "));

        const s = z.summary;
        tiles(zc, [
            ["Comfort maintained", `${Math.round(z.comfortOverallPercent)}%`, comfortRange(z)],
            ["Annual electricity", `${num(s.annualKWh)} kWh`, `${money(s.annualCost)} per year`],
            ["Average COP", s.avgCOP.toFixed(2), `Heating ${s.heatingAvgCOP.toFixed(2)} · Cooling ${s.coolingAvgCOP.toFixed(2)}`],
            ["Runtime", `${num(s.runtimeHours)} h/yr`, s.auxHeatHours > 0 ? `${num(s.auxHeatHours)} h/yr need backup heat` : "No backup heat needed"],
            ["Capacity at design", `${Math.round(z.capacityRatioAtHeatingDesign * 100)}% heating`, `${Math.round(z.capacityRatioAtCoolingDesign * 100)}% cooling · load ÷ capacity`],
        ]);

        chartBlock(zc, "Comfort maintained by outdoor temperature", "Share of hours the setpoint was held, in 5°F outdoor bins. Green ≥ 90%, yellow 70–89%, red < 70%.", (el) => {
            columnChart(el, {
                bins: z.comfortBins.map((b) => ({ label: `${Math.round(b.tempLow + 2.5)}`, value: b.comfortPercent, note: `${num(b.demandHours)} hours with demand · ${reasonLabel(b.dominantReason)}`, low: b.tempLow, high: b.tempHigh })),
                yMax: 100, xLabel: "Outdoor °F", yLabel: "Comfort %", format: (v) => `${Math.round(v)}%`,
                formatX: (b) => `${Math.round(b.low)}–${Math.round(b.high)}°F`,
                colorFor: (b) => b.value >= 90 ? palette.status.good : b.value >= 70 ? palette.status.warning : palette.status.critical,
            });
            legendStatus(el);
        });

        chartBlock(zc, "Psychrometric chart", "Where the outdoor air spent its hours (darker = more), the indoor comfort zone (dashed), and the unit's supply-air process lines.", (el) =>
            psychChart(el, { grid: z.psychGrid, comfortZone: z.comfortZone, processLines: z.processLines, title: "Psychrometric chart" }));

        const hist = document.createElement("div");
        hist.className = "tiles";
        zc.append(hist);
        for (const [title, bins, unit] of [["Outdoor temperature", z.temperatureHistogram, "°F"], ["Humidity", z.humidityHistogram, "gr/lb"], ["Enthalpy", z.enthalpyHistogram, "BTU/lb"]]) {
            const box = document.createElement("div");
            box.style.gridColumn = "span 1";
            hist.append(box);
            chartBlock(box, title, `Hours per ${unit} bin`, (el) =>
                columnChart(el, { bins: bins.map((b) => ({ label: `${Math.round(b.center)}`, value: b.count })), xLabel: unit, yLabel: "Hours", format: (v) => `${num(v)} h`, formatX: (b) => `${b.label} ${unit}` }));
        }
    }
}

function comfortRange(z) {
    if (z.coldestComfortableF == null && z.hottestComfortableF == null) return "";
    const parts = [];
    if (z.coldestComfortableF != null) parts.push(`comfortable down to ${Math.round(z.coldestComfortableF)}°F`);
    if (z.hottestComfortableF != null) parts.push(`up to ${Math.round(z.hottestComfortableF)}°F`);
    return parts.join(" and ");
}

function reasonLabel(r) {
    return { comfortable: "comfortable", tooCool: "mostly too cool", tooWarm: "mostly too warm", tooHumid: "mostly too humid", tooDry: "mostly too dry" }[r] ?? r;
}

function legendStatus(el) {
    const box = document.createElement("div");
    box.className = "legend";
    for (const [label, color] of [["≥ 90% comfortable", palette.status.good], ["70–89%", palette.status.warning], ["< 70%", palette.status.critical]]) {
        box.insertAdjacentHTML("beforeend", `<span class="legend-item"><span class="swatch" style="background:${color}"></span>${label}</span>`);
    }
    el.append(box);
}

// MARK: - Domestic Hot Water

function renderDHW() {
    const panel = $("panel-dhw");
    panel.innerHTML = "";
    const r = currentProject?.data?.dhwComparisonResults;
    if (!r) {
        note(card(panel, "Domestic Hot Water"), "Run the Domestic Hot Water comparison for this project in the app; the results appear here after it syncs.");
        return;
    }
    const demand = card(panel, "Hot water demand");
    tiles(demand, [
        ["Daily hot water", `${num(r.totalHotGallonsPerDay)} gal`],
        ["Peak draw", `${num(r.peakHotGallons)} gal`, `${num(r.peakBTUh)} BTU/h · ${r.peakHotGPM.toFixed(1)} GPM`],
        ["Long window", `${num(r.longWindowHotGallons)} gal`, `${num(r.longWindowBTUh)} BTU/h`],
        ["Temperature rise", `${Math.round(r.requiredRiseF)}°F`, `Last run ${formatDate(r.calculatedAt)}`],
    ]);

    const costed = r.candidates.filter((c) => c.annualCost != null).sort((a, b) => a.annualCost - b.annualCost);
    const costs = card(panel, "Annual operating cost");
    if (r.existingBaseline || costed.length) {
        const rows = [];
        if (r.existingBaseline) rows.push({ label: `${r.existingBaseline.name} (existing)`, value: r.existingBaseline.annualCost, color: palette.series[1], note: `${num(r.existingBaseline.annualEnergyAmount)} ${r.existingBaseline.energyUnitLabel} per year` });
        for (const c of costed) rows.push({ label: c.name, value: c.annualCost, color: palette.series[0], note: `${num(c.annualEnergyAmount)} ${c.energyUnitLabel} per year${r.existingBaseline ? ` · saves ${money(r.existingBaseline.annualCost - c.annualCost)}` : ""}` });
        chartBlock(costs, "Estimated cost per year", r.existingBaseline ? "The existing system is shown in orange." : "", (el) => hBarChart(el, { rows, format: money }));
    } else {
        note(costs, "No fuel prices were available for this run, so costs weren't estimated.");
    }

    const options = card(panel, "Options compared");
    const catLabel = { tank: "Storage tank", tankless: "Tankless", heatPump: "Heat pump", indirect: "Indirect" };
    table(options, ["Option", "Type", "Rating", "Peak", "Sustained", "Capacity", "Annual cost", "Notes"],
        r.candidates.map((c) => [c.name, catLabel[c.category] ?? c.category,
            `<span class="pill ${escape(c.recommendation)}">${escape(c.recommendation)}</span>`,
            passPill(c.passesPeak), passPill(c.passesLongWindow),
            c.category === "tankless" ? `${c.availableHotGPM?.toFixed(1) ?? "—"} GPM available / ${c.requiredHotGPM?.toFixed(1) ?? "—"} needed`
                : `${c.usableStorageGallons != null ? num(c.usableStorageGallons) + " gal usable" : ""}${c.recoveryGPH != null ? ` · ${num(c.recoveryGPH)} GPH recovery` : ""}${c.firstHourRatingGallons != null ? ` · FHR ${num(c.firstHourRatingGallons)}` : ""}`,
            c.annualCost != null ? money(c.annualCost) : "—", c.summaryMessage]), { html: true, textCols: [7] });
}

function passPill(ok) { return `<span class="pill ${ok ? "pass" : "fail"}">${ok ? "Pass" : "Fail"}</span>`; }

// MARK: - Building Intelligence

function renderIntelligence() {
    const panel = $("panel-intelligence");
    panel.innerHTML = "";
    const data = currentProject?.data ?? {};
    const p = data.currentEnergyProfile;
    const cal = data.lastCalibrationResult;
    if (!p) {
        note(card(panel, "Building Energy Intelligence"), "Open Building Intelligence for this project in the app once; its profile then appears here after each sync.");
        return;
    }
    const overview = card(panel, "Building overview");
    tiles(overview, [
        ["Conditioned area", `${num(p.conditionedFloorAreaSqFt)} sq ft`, `${p.roomCount} rooms${p.numberOfFloors ? ` · ${p.numberOfFloors} floors` : ""}`],
        ["Volume", `${num(p.conditionedVolumeCuFt)} cu ft`, `Avg ceiling ${p.averageCeilingHeightFt.toFixed(1)} ft`],
        ["Design heating load", `${num(p.designHeatingLoadBTUh)} BTU/h`, `${(p.designHeatingLoadBTUh / Math.max(1, p.conditionedFloorAreaSqFt)).toFixed(1)} BTU/h per sq ft`],
        ["Design cooling load", `${num(p.designCoolingLoadBTUh)} BTU/h`, `SHR ${p.coolingSHR.toFixed(2)}`],
        ["Air leakage", `${p.estimatedACH.toFixed(2)} ACH`, `Infiltration ${num(p.infiltrationHeatingBTUh)} BTU/h`],
        ["Heat loss rate", `${num(p.heatLossSlopeBTUhPerF)} BTU/h per °F`, `Envelope ${num(p.envelopeHeatLossBTUh)} BTU/h`],
    ]);
    note(overview, `Profile built ${formatDate(p.generatedDate)}.${p.hasMeasuredDimensions ? " Dimensions are measured." : ""}${p.hasUtilityBills ? " Utility bills on file." : ""}`);

    const breakdown = card(panel, "Heat loss by component");
    chartBlock(breakdown, "Design heating load by component", "", (el) =>
        hBarChart(el, { rows: [...p.heatingBreakdown].sort((a, b) => b.btuh - a.btuh).map((c) => ({ label: c.name, value: c.btuh })), format: (v) => `${num(v)} BTU/h` }));

    const a = p.annualEstimate;
    const annual = card(panel, "Estimated annual energy");
    if (a) {
        tiles(annual, [
            ["System", shortSystem(a.systemType), `${a.heatingFuel}`],
            ["Heating", `${num(a.annualHeatingEnergyUnits)} ${FUEL_UNITS[a.heatingFuel] ?? ""}`, `${money(a.annualHeatingCost)} per year`],
            ["Cooling", `${num(a.annualCoolingKWh)} kWh`, `${money(a.annualCoolingCost)} per year`],
            ["Total operating cost", money(a.annualOperatingCost), `Based on ${a.weatherYearsUsed} weather year${a.weatherYearsUsed === 1 ? "" : "s"}`],
        ]);
    } else {
        note(annual, "The annual estimate is calculated the next time the app opens Building Intelligence with weather available.");
    }

    const zones = p.equipmentZones?.length ? p.equipmentZones : (p.equipment ? [p.equipment] : []);
    if (zones.length) {
        const eq = card(panel, "Equipment");
        table(eq, ["Role", "System", "Models", "Rated efficiency", "Heating capacity", "Cooling capacity"],
            zones.map((z) => [z.role, z.systemType, (z.models ?? []).join(", "), z.ratedEfficiencyLabel ?? "—",
                z.ratedHeatingCapacityBTUh != null ? `${num(z.ratedHeatingCapacityBTUh)} BTU/h` : "—",
                z.ratedCoolingCapacityBTUh != null ? `${num(z.ratedCoolingCapacityBTUh)} BTU/h` : "—"]), { numericFrom: 4 });
    }

    if (p.utilityHistory?.length) {
        const util = card(panel, "Utility history");
        table(util, ["Fuel", "Bills", "Total use", "Total cost", "From", "To"],
            p.utilityHistory.map((u) => [u.fuelType, String(u.billCount), `${num(u.totalUnits)} ${FUEL_UNITS[u.fuelType] ?? ""}`, money(u.totalCost), shortDate(u.earliest), shortDate(u.latest)]), { numericFrom: 1 });
    }

    const calCard = card(panel, "Utility bill calibration");
    if (cal) {
        const quality = String(cal.dataQuality ?? "").toLowerCase();
        tiles(calCard, [
            ["Modeled vs billed", `${num(cal.totalPredictedUnits)} / ${num(cal.totalMeasuredUnits)} ${FUEL_UNITS[cal.fuelType] ?? ""}`, `${cal.annualErrorPercent >= 0 ? "+" : ""}${Math.round(cal.annualErrorPercent)}% overall`],
            ["Accuracy", `${Math.round(cal.accuracyPercent)}%`, `Confidence ${Math.round(cal.confidenceScore)}% · ${cal.billCount} bills`],
            ["Heating season error", `${Math.round(cal.heatingSeasonErrorPercent)}%`, cal.coolingSeasonErrorPercent != null ? `Cooling season ${Math.round(cal.coolingSeasonErrorPercent)}%` : ""],
            ["Data quality", quality ? quality[0].toUpperCase() + quality.slice(1) : "—", cal.dataQualityReason ?? ""],
        ]);
        chartBlock(calCard, "Estimated vs billed by period", "Each bar pair is one billing period.", (el) =>
            groupedColumnChart(el, {
                groups: cal.rows.map((row) => ({ label: shortDate(row.periodStart), values: [row.predictedUnits, row.measuredUnits] })),
                series: ["Estimated", "Billed"], format: (v) => `${num(v)} ${FUEL_UNITS[cal.fuelType] ?? ""}`, yLabel: FUEL_UNITS[cal.fuelType] ?? "",
            }));
        table(calCard, ["Period", "Days", "Avg outdoor", "Estimated", "Billed", "Error"],
            cal.rows.map((row) => [`${shortDate(row.periodStart)} – ${shortDate(row.periodEnd)}`, String(row.days), `${Math.round(row.avgOutdoorTempF)}°F`, num(row.predictedUnits), num(row.measuredUnits), `${row.errorPercent >= 0 ? "+" : ""}${Math.round(row.errorPercent)}%`]), { numericFrom: 1 });
        if (cal.notes?.length) note(calCard, cal.notes.join(" "));
    } else {
        note(calCard, "No calibration yet. Add utility bills and run the calibration in the app.");
    }
}

// MARK: - Reports

async function loadReports() {
    if (!currentProject) return;
    const uid = await userId();
    if (!uid) return;
    const folder = `${uid}/${currentProject.id}`;
    const list = $("report-list");
    list.innerHTML = "";
    const { data, error } = await supabase.storage.from(REPORTS_BUCKET).list(folder, { limit: 200, sortBy: { column: "updated_at", order: "desc" } });
    if (error) { showError(`Couldn't load reports: ${error.message}`); return; }
    const files = (data ?? []).filter((f) => f.id && f.name.toLowerCase().endsWith(".pdf"));
    $("reports-empty").classList.toggle("hidden", files.length > 0);
    for (const file of files) {
        const li = document.createElement("li");
        li.innerHTML = `<div><div class="report-name">${escape(reportTitle(file.name))}</div>
            <div class="report-meta">${escape([formatDate(file.updated_at ?? file.created_at), formatSize(file.metadata?.size)].filter(Boolean).join(" · "))}</div></div>`;
        const button = document.createElement("button");
        button.className = "download";
        button.textContent = "Download";
        button.addEventListener("click", () => downloadReport(`${folder}/${file.name}`, file.name, button));
        li.append(button);
        list.append(li);
    }
}

async function downloadReport(path, fileName, button) {
    button.disabled = true;
    button.textContent = "Preparing…";
    const { data, error } = await supabase.storage.from(REPORTS_BUCKET).createSignedUrl(path, 300, { download: fileName });
    button.disabled = false;
    button.textContent = "Download";
    if (error) { showError(`Couldn't download report: ${error.message}`); return; }
    window.location.href = data.signedUrl;
}

$("refresh-reports").addEventListener("click", loadReports);

function reportTitle(fileName) {
    let base = fileName.replace(/\.pdf$/i, "");
    const projectName = (currentProject?.name ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    if (projectName && base.startsWith(projectName + "_")) base = base.slice(projectName.length + 1);
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
    const uid = await userId();
    if (!uid) return;
    const prefix = `hourly_v2_${data.latitude.toFixed(3)}_${data.longitude.toFixed(3)}_`;
    const { data: files, error } = await supabase.storage.from(WEATHER_BUCKET).list(uid, { limit: 1000, search: prefix });
    if (error) { status.textContent = "Weather data status unavailable."; return; }
    const count = (files ?? []).filter((f) => f.id && f.name.startsWith(prefix)).length;
    status.textContent = count > 0
        ? `${count} hourly weather range${count === 1 ? "" : "s"} uploaded from the app for this location.`
        : "No weather data uploaded yet. In the app, open any energy analysis for this project (or re-save its address), then sync — the weather uploads automatically.";
}

// MARK: - Building blocks

function card(parent, title) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = `<h2>${escape(title)}</h2>`;
    parent.append(c);
    return c;
}

function note(parent, text) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = text;
    parent.append(p);
}

function tiles(parent, items) {
    const box = document.createElement("div");
    box.className = "tiles";
    for (const [label, value, sub] of items) {
        if (value == null || value === "") continue;
        box.insertAdjacentHTML("beforeend", `<div class="tile"><div class="tile-label">${escape(label)}</div><div class="tile-value">${escape(value)}</div>${sub ? `<div class="tile-note">${escape(sub)}</div>` : ""}</div>`);
    }
    parent.append(box);
}

function chartBlock(parent, title, subtitle, draw) {
    parent.insertAdjacentHTML("beforeend", `<p class="chart-title">${escape(title)}</p>${subtitle ? `<p class="chart-sub">${escape(subtitle)}</p>` : ""}`);
    const el = document.createElement("div");
    el.className = "chart";
    parent.append(el);
    // Draw after layout so the chart can read its width.
    requestAnimationFrame(() => draw(el));
}

function renderFacts(dl, rows) {
    dl.innerHTML = "";
    for (const [label, value] of rows) {
        if (value == null || value === "") continue;
        dl.insertAdjacentHTML("beforeend", `<dt>${escape(label)}</dt><dd>${escape(String(value))}</dd>`);
    }
}

function table(parent, headers, rows, { numericFrom = Infinity, footer, html = false, textCols = [] } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const t = document.createElement("table");
    t.className = "data-table";
    const cell = (tag, v, i) => `<${tag} class="${i >= numericFrom ? "num" : ""}${textCols.includes(i) ? " text" : ""}">${html ? v : escape(v)}</${tag}>`;
    t.innerHTML = `<thead><tr>${headers.map((h, i) => cell("th", h, i)).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((v, i) => cell("td", v, i)).join("")}</tr>`).join("")}</tbody>
        ${footer ? `<tfoot><tr>${footer.map((v, i) => cell("td", v, i)).join("")}</tr></tfoot>` : ""}`;
    wrap.append(t);
    parent.append(wrap);
}

/// Plain-language summary only — never the underlying method or constants.
function designConditionsSummary(data) {
    if (data.usesClimateZoneDesignConditions === false && (data.calculatedDesignConditions || data.derivedWinterDesignTemp != null)) {
        return "Calculated from the site's historical weather";
    }
    return "Climate zone estimate";
}

// MARK: - Formatting

function num(v) { return v == null || Number.isNaN(v) ? "" : Math.round(v).toLocaleString(); }
function pct(f) { return `${Math.round(f * 100)}%`; }
function money(v) { return v == null ? "" : v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }); }
function monthLabel(year, month) { return new Date(year, month - 1, 1).toLocaleString(undefined, { month: "short", year: "2-digit" }); }
function shortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function formatSize(bytes) {
    if (!bytes) return "";
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// MARK: - Boot

refreshSession().catch((error) => showError(error.message));
