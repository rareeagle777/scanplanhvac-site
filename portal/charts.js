// Small chart module for the portal. Plain SVG/Canvas, no dependencies.
//
// Palette and mark rules follow the validated reference palette: categorical hues are assigned
// in a fixed order (never cycled), one hue light→dark for magnitude, status colors reserved for
// good/warning/critical and always paired with a label. Thin marks, baseline-anchored rounded
// ends, a 2px surface gap between fills, recessive gridlines, hover tooltips on every mark.

export const palette = {
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
    sequential: ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"],
    status: { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" },
    ink: "#0b0b0b",
    inkSecondary: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    surface: "#fcfcfb",
};

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.append(node);
    return node;
}

function text(parent, x, y, str, attrs = {}) {
    const t = el("text", { x, y, fill: palette.inkSecondary, "font-size": 12, ...attrs }, parent);
    t.textContent = str;
    return t;
}

// MARK: - Tooltip

const tooltip = document.getElementById("tooltip");

function attachTooltip(node, html) {
    node.addEventListener("mousemove", (e) => {
        tooltip.innerHTML = html;
        tooltip.classList.remove("hidden");
        const pad = 12;
        let x = e.clientX + pad, y = e.clientY + pad;
        const r = tooltip.getBoundingClientRect();
        if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
        if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    });
    node.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
}

function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * p;
}

function ticks(max, count = 4) {
    const out = [];
    for (let i = 0; i <= count; i++) out.push((max / count) * i);
    return out;
}

export function legend(container, items) {
    const box = document.createElement("div");
    box.className = "legend";
    for (const it of items) {
        const row = document.createElement("span");
        row.className = "legend-item";
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = it.color;
        row.append(swatch, document.createTextNode(it.label));
        box.append(row);
    }
    container.append(box);
    return box;
}

// MARK: - Horizontal bars (single series, optional per-row color)

export function hBarChart(container, { rows, format, highlight }) {
    container.innerHTML = "";
    if (!rows.length) return;
    const labelW = 160, valueW = 90, rowH = 26, pad = 8;
    const width = Math.max(420, container.clientWidth || 640);
    const plotW = width - labelW - valueW - pad * 2;
    const height = rows.length * rowH + pad * 2;
    const max = niceMax(Math.max(...rows.map((r) => Math.abs(r.value))));
    const svg = el("svg", { width: "100%", viewBox: `0 0 ${width} ${height}`, role: "img" }, container);

    rows.forEach((r, i) => {
        const y = pad + i * rowH;
        const w = Math.max(0, (Math.abs(r.value) / max) * plotW);
        const color = r.color ?? (highlight && highlight(r) ? palette.series[1] : palette.series[0]);
        const label = text(svg, labelW - 8, y + rowH / 2 + 4, r.label, { "text-anchor": "end", fill: palette.ink });
        if (r.label.length > 24) label.textContent = r.label.slice(0, 23) + "…";
        const g = el("g", {}, svg);
        el("rect", { x: labelW, y: y + 5, width: plotW, height: rowH - 10, fill: "transparent" }, g);
        el("rect", { x: labelW, y: y + 7, width: w, height: rowH - 14, rx: 4, fill: color }, g);
        text(svg, labelW + plotW + 8, y + rowH / 2 + 4, format(r.value), { fill: palette.ink, "font-variant-numeric": "tabular-nums" });
        attachTooltip(g, `<strong>${escape(r.label)}</strong><br>${escape(format(r.value))}${r.note ? `<br><span class="muted">${escape(r.note)}</span>` : ""}`);
    });
}

// MARK: - Stacked horizontal bars (fixed series order, legend + 2px gaps)

export function stackedHBarChart(container, { rows, series, format }) {
    container.innerHTML = "";
    if (!rows.length) return;
    const colors = Object.fromEntries(series.map((s, i) => [s, palette.series[i % palette.series.length]]));
    const labelW = 160, valueW = 90, rowH = 26, pad = 8;
    const width = Math.max(420, container.clientWidth || 640);
    const plotW = width - labelW - valueW - pad * 2;
    const height = rows.length * rowH + pad * 2;
    const totals = rows.map((r) => r.segments.reduce((n, s) => n + Math.max(0, s.value), 0));
    const max = niceMax(Math.max(...totals));
    const svg = el("svg", { width: "100%", viewBox: `0 0 ${width} ${height}`, role: "img" }, container);

    rows.forEach((r, i) => {
        const y = pad + i * rowH;
        const label = text(svg, labelW - 8, y + rowH / 2 + 4, r.label, { "text-anchor": "end", fill: palette.ink });
        if (r.label.length > 24) label.textContent = r.label.slice(0, 23) + "…";
        let x = labelW;
        for (const s of series) {
            const seg = r.segments.find((q) => q.name === s);
            if (!seg || seg.value <= 0) continue;
            const w = (seg.value / max) * plotW;
            if (w < 0.5) continue;
            const g = el("g", {}, svg);
            el("rect", { x, y: y + 7, width: Math.max(0, w - 2), height: rowH - 14, fill: colors[s] }, g);
            attachTooltip(g, `<strong>${escape(r.label)}</strong><br>${escape(s)}: ${escape(format(seg.value))}<br><span class="muted">Total ${escape(format(totals[i]))}</span>`);
            x += w;
        }
        text(svg, labelW + plotW + 8, y + rowH / 2 + 4, format(totals[i]), { fill: palette.ink, "font-variant-numeric": "tabular-nums" });
    });
    legend(container, series.map((s) => ({ label: s, color: colors[s] })));
}

// MARK: - Columns (histograms, comfort-by-temperature)

export function columnChart(container, { bins, xLabel, yLabel, yMax, format, formatX, colorFor }) {
    container.innerHTML = "";
    if (!bins.length) return;
    const width = Math.max(420, container.clientWidth || 640), height = 220;
    const m = { l: 52, r: 12, t: 12, b: 40 };
    const plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    const max = yMax ?? niceMax(Math.max(...bins.map((b) => b.value)));
    const svg = el("svg", { width: "100%", viewBox: `0 0 ${width} ${height}`, role: "img" }, container);

    for (const tv of ticks(max)) {
        const y = m.t + plotH - (tv / max) * plotH;
        el("line", { x1: m.l, x2: m.l + plotW, y1: y, y2: y, stroke: palette.grid }, svg);
        text(svg, m.l - 6, y + 4, format(tv), { "text-anchor": "end", fill: palette.muted, "font-size": 11 });
    }
    el("line", { x1: m.l, x2: m.l + plotW, y1: m.t + plotH, y2: m.t + plotH, stroke: palette.axis }, svg);

    const slot = plotW / bins.length;
    const barW = Math.max(2, slot - 2);
    const labelEvery = Math.ceil(bins.length / 10);
    bins.forEach((b, i) => {
        const h = Math.max(0, (b.value / max) * plotH);
        const x = m.l + i * slot + (slot - barW) / 2;
        const y = m.t + plotH - h;
        const g = el("g", {}, svg);
        el("rect", { x: m.l + i * slot, y: m.t, width: slot, height: plotH, fill: "transparent" }, g);
        el("rect", { x, y, width: barW, height: h, rx: Math.min(4, barW / 2), fill: colorFor ? colorFor(b) : palette.series[0] }, g);
        if (h > 0) el("rect", { x, y: m.t + plotH - Math.min(h, 4), width: barW, height: Math.min(h, 4), fill: colorFor ? colorFor(b) : palette.series[0] }, g);
        attachTooltip(g, `<strong>${escape(formatX ? formatX(b) : b.label)}</strong><br>${escape(format(b.value))}${b.note ? `<br><span class="muted">${escape(b.note)}</span>` : ""}`);
        if (i % labelEvery === 0) text(svg, m.l + i * slot + slot / 2, height - m.b + 16, b.label, { "text-anchor": "middle", fill: palette.muted, "font-size": 11 });
    });
    if (xLabel) text(svg, m.l + plotW / 2, height - 6, xLabel, { "text-anchor": "middle", fill: palette.muted, "font-size": 11 });
    if (yLabel) text(svg, 12, m.t + 10, yLabel, { fill: palette.muted, "font-size": 11 });
}

// MARK: - Grouped columns (2–3 series side by side)

export function groupedColumnChart(container, { groups, series, format, yLabel }) {
    container.innerHTML = "";
    if (!groups.length) return;
    const colors = series.map((_, i) => palette.series[i]);
    const width = Math.max(420, container.clientWidth || 640), height = 240;
    const m = { l: 56, r: 12, t: 12, b: 48 };
    const plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    const max = niceMax(Math.max(...groups.flatMap((g) => g.values)));
    const svg = el("svg", { width: "100%", viewBox: `0 0 ${width} ${height}`, role: "img" }, container);
    for (const tv of ticks(max)) {
        const y = m.t + plotH - (tv / max) * plotH;
        el("line", { x1: m.l, x2: m.l + plotW, y1: y, y2: y, stroke: palette.grid }, svg);
        text(svg, m.l - 6, y + 4, format(tv), { "text-anchor": "end", fill: palette.muted, "font-size": 11 });
    }
    el("line", { x1: m.l, x2: m.l + plotW, y1: m.t + plotH, y2: m.t + plotH, stroke: palette.axis }, svg);
    const slot = plotW / groups.length;
    const inner = slot * 0.7;
    const barW = Math.max(2, inner / series.length - 2);
    const labelEvery = Math.ceil(groups.length / 8);
    groups.forEach((g, gi) => {
        const x0 = m.l + gi * slot + (slot - inner) / 2;
        const hit = el("g", {}, svg);
        el("rect", { x: m.l + gi * slot, y: m.t, width: slot, height: plotH, fill: "transparent" }, hit);
        g.values.forEach((v, si) => {
            const h = Math.max(0, (v / max) * plotH);
            el("rect", { x: x0 + si * (barW + 2), y: m.t + plotH - h, width: barW, height: h, rx: Math.min(4, barW / 2), fill: colors[si] }, hit);
        });
        attachTooltip(hit, `<strong>${escape(g.label)}</strong><br>` + series.map((s, si) => `${escape(s)}: ${escape(format(g.values[si]))}`).join("<br>"));
        if (gi % labelEvery === 0) text(svg, m.l + gi * slot + slot / 2, height - m.b + 16, g.label, { "text-anchor": "middle", fill: palette.muted, "font-size": 11 });
    });
    if (yLabel) text(svg, 12, m.t + 10, yLabel, { fill: palette.muted, "font-size": 11 });
    legend(container, series.map((s, i) => ({ label: s, color: colors[i] })));
}

// MARK: - Lines over categories (monthly costs per system)

export function lineChart(container, { categories, series, format, yLabel }) {
    container.innerHTML = "";
    if (!categories.length || !series.length) return;
    const shown = series.slice(0, palette.series.length);
    const width = Math.max(420, container.clientWidth || 640), height = 260;
    const m = { l: 56, r: 16, t: 12, b: 44 };
    const plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    const max = niceMax(Math.max(...shown.flatMap((s) => s.values)));
    const svg = el("svg", { width: "100%", viewBox: `0 0 ${width} ${height}`, role: "img" }, container);
    for (const tv of ticks(max)) {
        const y = m.t + plotH - (tv / max) * plotH;
        el("line", { x1: m.l, x2: m.l + plotW, y1: y, y2: y, stroke: palette.grid }, svg);
        text(svg, m.l - 6, y + 4, format(tv), { "text-anchor": "end", fill: palette.muted, "font-size": 11 });
    }
    el("line", { x1: m.l, x2: m.l + plotW, y1: m.t + plotH, y2: m.t + plotH, stroke: palette.axis }, svg);
    const step = categories.length > 1 ? plotW / (categories.length - 1) : plotW;
    const xAt = (i) => m.l + (categories.length > 1 ? i * step : plotW / 2);
    const yAt = (v) => m.t + plotH - (v / max) * plotH;
    const labelEvery = Math.ceil(categories.length / 8);
    categories.forEach((c, i) => {
        if (i % labelEvery === 0) text(svg, xAt(i), height - m.b + 16, c, { "text-anchor": "middle", fill: palette.muted, "font-size": 11 });
    });
    shown.forEach((s, si) => {
        const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(v)}`).join(" ");
        el("path", { d, fill: "none", stroke: palette.series[si], "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    });
    // Crosshair + tooltip per category.
    const cross = el("line", { x1: 0, x2: 0, y1: m.t, y2: m.t + plotH, stroke: palette.axis, "stroke-dasharray": "3 3", opacity: 0 }, svg);
    categories.forEach((c, i) => {
        const g = el("g", {}, svg);
        el("rect", { x: xAt(i) - step / 2, y: m.t, width: Math.max(step, 6), height: plotH, fill: "transparent" }, g);
        shown.forEach((s, si) => el("circle", { cx: xAt(i), cy: yAt(s.values[i]), r: 4, fill: palette.series[si], stroke: palette.surface, "stroke-width": 2 }, g));
        g.addEventListener("mouseenter", () => { cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i)); cross.setAttribute("opacity", 1); });
        g.addEventListener("mouseleave", () => cross.setAttribute("opacity", 0));
        attachTooltip(g, `<strong>${escape(c)}</strong><br>` + shown.map((s, si) => `<span class="swatch" style="background:${palette.series[si]}"></span>${escape(s.name)}: ${escape(format(s.values[i]))}`).join("<br>"));
    });
    if (yLabel) text(svg, 12, m.t + 10, yLabel, { fill: palette.muted, "font-size": 11 });
    legend(container, shown.map((s, i) => ({ label: s.name, color: palette.series[i] })));
    if (series.length > shown.length) {
        const note = document.createElement("p");
        note.className = "muted small";
        note.textContent = `Showing the first ${shown.length} systems.`;
        container.append(note);
    }
}

// MARK: - Psychrometric heatmap (canvas)

export function psychChart(container, { grid, comfortZone, processLines, title }) {
    container.innerHTML = "";
    const width = Math.max(420, container.clientWidth || 640), height = 320;
    const m = { l: 56, r: 16, t: 12, b: 44 };
    const plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    const canvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = "100%"; canvas.style.aspectRatio = `${width} / ${height}`;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", title ?? "Psychrometric chart");
    container.append(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const xAt = (db) => m.l + ((db - grid.minDryBulbF) / (grid.maxDryBulbF - grid.minDryBulbF)) * plotW;
    const yAt = (gr) => m.t + plotH - ((gr - grid.minGrains) / (grid.maxGrains - grid.minGrains)) * plotH;

    // Gridlines + axes
    ctx.strokeStyle = palette.grid; ctx.lineWidth = 1; ctx.fillStyle = palette.muted; ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (let db = Math.ceil(grid.minDryBulbF / 20) * 20; db <= grid.maxDryBulbF; db += 20) {
        ctx.beginPath(); ctx.moveTo(xAt(db), m.t); ctx.lineTo(xAt(db), m.t + plotH); ctx.stroke();
        ctx.fillText(`${db}°`, xAt(db), height - m.b + 16);
    }
    ctx.textAlign = "right";
    for (let gr = 0; gr <= grid.maxGrains; gr += 40) {
        ctx.beginPath(); ctx.moveTo(m.l, yAt(gr)); ctx.lineTo(m.l + plotW, yAt(gr)); ctx.stroke();
        ctx.fillText(`${gr}`, m.l - 6, yAt(gr) + 4);
    }
    ctx.textAlign = "center";
    ctx.fillText("Outdoor dry-bulb (°F)", m.l + plotW / 2, height - 6);
    ctx.save(); ctx.translate(14, m.t + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("Humidity (gr/lb)", 0, 0); ctx.restore();

    // Saturation curve (100% RH) — standard psychrometric relation, drawn for orientation.
    ctx.strokeStyle = palette.axis; ctx.lineWidth = 1.5; ctx.beginPath();
    let started = false;
    for (let db = grid.minDryBulbF; db <= grid.maxDryBulbF; db += 1) {
        const gr = saturationGrains(db);
        if (gr > grid.maxGrains) break;
        const x = xAt(db), y = yAt(gr);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Density cells (log scale, one hue light→dark)
    const maxCount = Math.max(1, ...grid.counts);
    const logMax = Math.log(maxCount + 1);
    const cellW = plotW / grid.columns, cellH = plotH / grid.rows;
    for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.columns; col++) {
            const c = grid.counts[row * grid.columns + col];
            if (!c) continue;
            const t = Math.log(c + 1) / logMax;
            const idx = Math.min(palette.sequential.length - 1, Math.floor(t * palette.sequential.length));
            ctx.fillStyle = palette.sequential[idx];
            ctx.fillRect(m.l + col * cellW, m.t + plotH - (row + 1) * cellH, cellW + 0.5, cellH + 0.5);
        }
    }

    // Comfort zone polygon
    if (comfortZone?.length) {
        ctx.strokeStyle = palette.status.good; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        ctx.beginPath();
        comfortZone.forEach(([db, gr], i) => (i === 0 ? ctx.moveTo(xAt(db), yAt(gr)) : ctx.lineTo(xAt(db), yAt(gr))));
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    }

    // Equipment process lines (return → supply)
    for (const p of processLines ?? []) {
        const color = p.mode === "cooling" ? palette.series[0] : palette.series[1];
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(xAt(p.returnDryBulbF), yAt(p.returnGrains)); ctx.lineTo(xAt(p.supplyDryBulbF), yAt(p.supplyGrains)); ctx.stroke();
        ctx.beginPath(); ctx.arc(xAt(p.supplyDryBulbF), yAt(p.supplyGrains), 4, 0, Math.PI * 2); ctx.fill();
    }

    // Hover: report the cell under the pointer.
    const hit = document.createElement("div");
    hit.className = "canvas-hit";
    container.style.position = "relative";
    container.append(hit);
    hit.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect();
        const sx = (e.clientX - r.left) * (width / r.width), sy = (e.clientY - r.top) * (height / r.height);
        const db = grid.minDryBulbF + ((sx - m.l) / plotW) * (grid.maxDryBulbF - grid.minDryBulbF);
        const gr = grid.minGrains + ((m.t + plotH - sy) / plotH) * (grid.maxGrains - grid.minGrains);
        const col = Math.floor(((db - grid.minDryBulbF) / (grid.maxDryBulbF - grid.minDryBulbF)) * grid.columns);
        const row = Math.floor(((gr - grid.minGrains) / (grid.maxGrains - grid.minGrains)) * grid.rows);
        if (col < 0 || col >= grid.columns || row < 0 || row >= grid.rows) { tooltip.classList.add("hidden"); return; }
        const c = grid.counts[row * grid.columns + col];
        tooltip.innerHTML = `${Math.round(db)}°F · ${Math.round(gr)} gr/lb<br><strong>${c} hour${c === 1 ? "" : "s"}</strong>`;
        tooltip.classList.remove("hidden");
        tooltip.style.left = `${e.clientX + 12}px`; tooltip.style.top = `${e.clientY + 12}px`;
    });
    hit.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));

    const items = [{ label: "Hours (light → dark = more)", color: palette.sequential[8] }, { label: "Comfort zone", color: palette.status.good }];
    if (processLines?.some((p) => p.mode === "cooling")) items.push({ label: "Cooling supply air", color: palette.series[0] });
    if (processLines?.some((p) => p.mode === "heating")) items.push({ label: "Heating supply air", color: palette.series[1] });
    legend(container, items);
}

/// Humidity ratio at saturation (grains/lb) for a dry-bulb °F at sea level — chart reference only.
function saturationGrains(dbF) {
    const tC = (dbF - 32) / 1.8;
    const pws = 6.112 * Math.exp((17.62 * tC) / (243.12 + tC)); // hPa (Magnus)
    const w = 0.622 * pws / (1013.25 - pws);
    return w * 7000;
}

export function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
