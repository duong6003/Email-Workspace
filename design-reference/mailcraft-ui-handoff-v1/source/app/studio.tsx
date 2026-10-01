"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor as GrapesEditor } from "grapesjs";
type Locale = "vi" | "en";
type Device = "desktop" | "mobile";
type Align = "left" | "center" | "right";
type Kind = "section" | "row" | "column" | "text" | "heading" | "button" | "image" | "banner" | "logo" | "social" | "table" | "divider" | "spacer" | "contact" | "preheader" | "custom";
type Leaf = Exclude<Kind, "section" | "row" | "column">;
type LayoutKind = "layout1" | "layout2" | "layout2left" | "layout2right" | "layout3" | "layout4";
type BlockKind = Leaf | LayoutKind | "section";
type Panel = "templates" | "variables" | "assets" | "review" | "preview" | "history" | "publish" | "html" | null;
type Variable = {
    key: string;
    name: string;
    scope: "system" | "shared" | "recipient" | "template";
    fallback: string;
    required: boolean;
    campaignOverride: boolean;
};
type Social = {
    id: string;
    platform: "facebook" | "linkedin" | "instagram" | "youtube" | "website";
    url: string;
    label?: string;
    enabled: boolean;
};
type ContactData = {
    name: string;
    role: string;
    email: string;
    phone: string;
    address: string;
};
type Table = {
    rows: number;
    cols: number;
    header: boolean;
    headerColumn: boolean;
    zebra: boolean;
    caption: string;
    cells: string[][];
    headerBg: string;
    headerColor: string;
    rowBg: string;
    altBg: string;
    borderColor: string;
    cellPadding: number;
    radius: number;
    align: Align;
    widths: number[];
    cellStyles?: Partial<Node>[][];
    cellTags?: ("td" | "th")[][];
};
type InlineNode = {
    type: "text" | "br" | "link" | "strong" | "em" | "span";
    text?: string;
    href?: string;
    title?: string;
    children?: InlineNode[];
};
type Node = {
    id: string;
    kind: Kind;
    name?: string;
    children?: Node[];
    content?: string;
    align?: Align;
    padding?: number;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    marginTop?: number;
    marginRight?: number;
    marginBottom?: number;
    marginLeft?: number;
    background?: string;
    backgroundMode?: "solid" | "gradient";
    gradientTo?: string;
    gradientAngle?: number;
    elevation?: "flat" | "soft" | "strong" | "inset";
    shadowColor?: string;
    textColor?: string;
    accent?: string;
    visible?: boolean;
    locked?: boolean;
    gap?: number;
    stackMobile?: boolean;
    width?: number;
    href?: string;
    linkTitle?: string;
    src?: string;
    mobileSrc?: string;
    assetId?: string;
    alt?: string;
    caption?: string;
    radius?: number;
    headingLevel?: 1 | 2 | 3 | 4;
    fontSize?: number;
    lineHeight?: number;
    lineHeightRaw?: string;
    fontWeight?: number;
    fontWeightRaw?: string;
    fontFamily?: string;
    letterSpacing?: number;
    italic?: boolean;
    textTransform?: "none" | "uppercase" | "lowercase";
    borderColor?: string;
    borderWidth?: number;
    maxWidth?: number;
    widthPx?: number;
    objectFit?: "cover" | "contain";
    buttonVariant?: "solid" | "outline" | "soft" | "link";
    buttonSize?: "sm" | "md" | "lg";
    buttonWidth?: "auto" | "full";
    buttonIcon?: "none" | "left" | "right";
    social?: Social[];
    socialStyle?: "circle" | "square" | "text";
    socialSize?: number;
    contact?: ContactData;
    table?: Table;
    html?: string;
    css?: string;
    inline?: InlineNode[];
    sourceHtml?: string;
    strategy?: "native" | "preserve";
    fragmentId?: string;
    height?: number;
};
type EmailTheme = {
    width: 600 | 640 | 720;
    outerBg: string;
    contentBg: string;
    fontFamily: string;
    baseFontSize: number;
};
type Doc = {
    title: string;
    nodes: Node[];
    variables: Variable[];
    theme?: EmailTheme;
};
type History = {
    past: Doc[];
    present: Doc;
    future: Doc[];
};
type ImportReport = {
    nativeBlocks: number;
    customBlocks: number;
    blocked: number;
    missingAssets: string[];
    variables: string[];
    warnings: string[];
    preservedBlocks: number;
    dropped: string[];
    unsupportedCss: string[];
    externalAssets: string[];
    coverage: { text: number; links: number; images: number; variables: number };
};
type Asset = {
    id: string;
    name: string;
    type: "image" | "logo";
    src: string;
    tone: string;
    size: string;
};
type AssetTarget = {
    nodeId: string | null;
    accept: "all" | Asset["type"];
    mode: "insert" | "replace";
};
type TemplatePreset = {
    id: string;
    category: "hr" | "internal" | "event";
    tone: "sage" | "sand" | "blue" | "plum";
    vi: string;
    en: string;
    descVi: string;
    descEn: string;
    blocks: number;
};
type SavedBlock = {
    id: string;
    name: string;
    node: Node;
    elements: number;
};
let seq = 80;
const uid = (p = "node") => `${p}-${++seq}`;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const tr = (l: Locale, vi: string, en: string) => l === "vi" ? vi : en;
const defaultTheme: EmailTheme = { width: 640, outerBg: "#f3f1ed", contentBg: "#ffffff", fontFamily: "Arial, Helvetica, sans-serif", baseFontSize: 14 };
const defaultTable = (): Table => ({ rows: 3, cols: 3, header: true, headerColumn: false, zebra: true, caption: "Lịch trình ngày đầu", cells: [["Hạng mục", "Thời gian", "Phụ trách"], ["Nhận thiết bị", "08:30", "IT Support"], ["Gặp đội ngũ", "10:00", "{{phong_ban}}"]], headerBg: "#173f33", headerColor: "#ffffff", rowBg: "#ffffff", altBg: "#f2f6f4", borderColor: "#dbe5e0", cellPadding: 12, radius: 8, align: "left", widths: [40, 25, 35] });
const variables: Variable[] = [{ key: "ten_nhan_vien", name: "Tên nhân viên", scope: "recipient", fallback: "Nguyễn Thu Hà", required: true, campaignOverride: false }, { key: "phong_ban", name: "Phòng ban", scope: "recipient", fallback: "Nhân sự", required: false, campaignOverride: false }, { key: "ten_cong_ty", name: "Tên công ty", scope: "shared", fallback: "Altasoftware", required: true, campaignOverride: true }, { key: "email_ho_tro", name: "Email hỗ trợ", scope: "shared", fallback: "hr@altasoftware.vn", required: false, campaignOverride: true }, { key: "ngay_hien_tai", name: "Ngày hiện tại", scope: "system", fallback: "26/08/2026", required: true, campaignOverride: false }];
const initial: Doc = { title: "Chào mừng nhân viên tháng 8", variables, theme: defaultTheme, nodes: [{ id: "section-main", kind: "section", name: "Nội dung chính", background: "#fff", visible: true, children: [{ id: "row-hero", kind: "row", name: "Lời chào", gap: 0, stackMobile: true, visible: true, children: [{ id: "col-hero", kind: "column", padding: 42, background: "#e8e2d6", visible: true, width: 100, children: [{ id: "logo-1", kind: "logo", content: "ALTA", assetId: "logo-alta", src: "https://alta-s3.dev-altamedia.com/public/local-alta.png", alt: "Altasoftware", href: "https://altasoftware.vn", align: "left", height: 34, accent: "#173f33", visible: true }, { id: "heading-1", kind: "heading", headingLevel: 1, fontSize: 38, lineHeight: 1.12, fontWeight: 700, content: "Chào mừng {{ten_nhan_vien}}!", align: "left", textColor: "#193c31", padding: 18, visible: true }, { id: "text-1", kind: "text", fontSize: 14, lineHeight: 1.65, fontWeight: 400, content: "Chúng tôi rất vui khi bạn gia nhập {{ten_cong_ty}}. Cùng bắt đầu hành trình mới thật nhiều cảm hứng.", align: "left", textColor: "#40534b", visible: true }, { id: "button-1", kind: "button", content: "Xem cẩm nang nhân viên", href: "https://example.com/cam-nang", linkTitle: "Mở cẩm nang nhân viên", align: "left", accent: "#173f33", textColor: "#fff", buttonVariant: "solid", buttonSize: "md", buttonWidth: "auto", buttonIcon: "right", radius: 8, padding: 24, visible: true }] }] }, { id: "row-info", kind: "row", name: "Thông tin ngày đầu", gap: 16, stackMobile: true, visible: true, children: [{ id: "col-info", kind: "column", padding: 34, background: "#fff", visible: true, width: 100, children: [{ id: "heading-2", kind: "heading", headingLevel: 2, fontSize: 28, lineHeight: 1.2, fontWeight: 700, content: "Lịch trình ngày đầu", align: "left", textColor: "#193c31", visible: true }, { id: "table-1", kind: "table", name: "Bảng lịch trình", table: defaultTable(), padding: 20, visible: true }] }] }, { id: "row-footer", kind: "row", name: "Chân trang", gap: 0, stackMobile: true, visible: true, children: [{ id: "col-footer", kind: "column", padding: 28, background: "#173f33", visible: true, width: 100, children: [{ id: "social-1", kind: "social", align: "center", accent: "#fff", socialStyle: "circle", socialSize: 32, social: [{ id: "soc-1", platform: "facebook", url: "https://facebook.com/altasoftware", label: "Facebook Altasoftware", enabled: true }, { id: "soc-2", platform: "linkedin", url: "https://linkedin.com/company/altasoftware", label: "LinkedIn Altasoftware", enabled: true }, { id: "soc-3", platform: "website", url: "https://altasoftware.vn", label: "Website Altasoftware", enabled: true }], visible: true }, { id: "contact-1", kind: "contact", content: "Phòng Nhân sự · Altasoftware\nhr@altasoftware.vn · (+84) 28 3999 0000", contact: { name: "Phòng Nhân sự", role: "Altasoftware", email: "hr@altasoftware.vn", phone: "(+84) 28 3999 0000", address: "" }, align: "center", textColor: "#dce8e3", fontSize: 12, lineHeight: 1.6, padding: 18, visible: true }] }] }] }] };
const assets: Asset[] = [{ id: "logo-alta", name: "ALTA — Logo chính", type: "logo", src: "https://alta-s3.dev-altamedia.com/public/local-alta.png", tone: "forest", size: "320 × 88" }, { id: "logo-light", name: "ALTA — Logo nền tối", type: "logo", src: "https://alta-s3.dev-altamedia.com/public/local-alta.png", tone: "dark", size: "320 × 88" }, { id: "logo-wordmark", name: "Altasoftware — Wordmark", type: "logo", src: "https://alta-s3.dev-altamedia.com/public/local-alta.png", tone: "cream", size: "420 × 96" }, { id: "office", name: "Văn phòng Altasoftware", type: "image", src: "https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1200&q=82", tone: "sage", size: "1200 × 720" }, { id: "welcome", name: "Chào mừng nhân viên", type: "image", src: "https://images.unsplash.com/photo-1521737711867-e3b97375f902?auto=format&fit=crop&w=1200&q=82", tone: "blue", size: "1200 × 720" }, { id: "desk", name: "Không gian làm việc", type: "image", src: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1200&q=82", tone: "sand", size: "1200 × 720" }];
const layoutSpecs: Record<LayoutKind, {
    widths: number[];
    icon: string;
    vi: string;
    en: string;
}> = { layout1: { widths: [100], icon: "▭", vi: "Một cột", en: "Single column" }, layout2: { widths: [50, 50], icon: "▥", vi: "Hai cột đều", en: "Equal columns" }, layout2left: { widths: [35, 65], icon: "▯▭", vi: "Trái hẹp · phải rộng", en: "Narrow left · wide right" }, layout2right: { widths: [65, 35], icon: "▭▯", vi: "Trái rộng · phải hẹp", en: "Wide left · narrow right" }, layout3: { widths: [33, 34, 33], icon: "▦", vi: "Ba cột đều", en: "Three columns" }, layout4: { widths: [25, 25, 25, 25], icon: "▥▥", vi: "Bốn cột", en: "Four columns" } };
const blocks: {
    kind: BlockKind;
    icon: string;
    vi: string;
    en: string;
    group: string;
}[] = [{ kind: "text", icon: "T", vi: "Đoạn văn", en: "Paragraph", group: "content" }, { kind: "heading", icon: "H", vi: "Tiêu đề", en: "Heading", group: "content" }, { kind: "image", icon: "▧", vi: "Hình ảnh", en: "Image", group: "media" }, { kind: "banner", icon: "▰", vi: "Banner", en: "Banner", group: "media" }, { kind: "logo", icon: "A", vi: "Logo", en: "Logo", group: "media" }, { kind: "button", icon: "↗", vi: "Nút bấm", en: "Button", group: "action" }, { kind: "social", icon: "◎", vi: "Mạng xã hội", en: "Social links", group: "action" }, { kind: "section", icon: "▱", vi: "Section trống", en: "Blank section", group: "layout" }, ...Object.entries(layoutSpecs).map(([kind, x]) => ({ kind: kind as LayoutKind, icon: x.icon, vi: x.vi, en: x.en, group: "layout" })), { kind: "table", icon: "▤", vi: "Bảng dữ liệu", en: "Data table", group: "layout" }, { kind: "divider", icon: "—", vi: "Đường ngăn", en: "Divider", group: "layout" }, { kind: "spacer", icon: "↕", vi: "Khoảng cách", en: "Spacer", group: "layout" }, { kind: "contact", icon: "@", vi: "Liên hệ", en: "Contact", group: "email" }, { kind: "preheader", icon: "P", vi: "Preheader", en: "Preheader", group: "email" }, { kind: "custom", icon: "</>", vi: "HTML/CSS tùy chỉnh", en: "Custom HTML/CSS", group: "email" }];
const templatePresets: TemplatePreset[] = [
    { id: "welcome", category: "hr", tone: "sage", vi: "Chào mừng nhân viên", en: "Employee welcome", descVi: "Lời chào, lịch ngày đầu và người đồng hành", descEn: "Welcome, first-day agenda and buddy", blocks: 8 },
    { id: "onboarding", category: "hr", tone: "sand", vi: "Onboarding 7 ngày", en: "7-day onboarding", descVi: "Lộ trình tuần đầu rõ ràng, dễ theo dõi", descEn: "A clear, easy-to-follow first week", blocks: 11 },
    { id: "newsletter", category: "internal", tone: "blue", vi: "Bản tin nội bộ", en: "Internal newsletter", descVi: "Tin tức, con người và điểm nhấn trong tháng", descEn: "News, people and monthly highlights", blocks: 9 },
    { id: "townhall", category: "event", tone: "plum", vi: "Mời tham gia Town Hall", en: "Town Hall invitation", descVi: "Thông tin sự kiện và nút xác nhận tham dự", descEn: "Event details and RSVP action", blocks: 6 },
];
function find(nodes: Node[], id: string): Node | undefined { for (const n of nodes) {
    if (n.id === id)
        return n;
    const f = n.children && find(n.children, id);
    if (f)
        return f;
} }
function findParent(nodes: Node[], id: string, parent?: Node): Node | undefined { for (const n of nodes) {
    if (n.id === id)
        return parent;
    const found = n.children && findParent(n.children, id, n);
    if (found)
        return found;
} }
function map(nodes: Node[], id: string, fn: (n: Node) => Node): Node[] { return nodes.map(n => n.id === id ? fn(n) : n.children ? { ...n, children: map(n.children, id, fn) } : n); }
function remove(nodes: Node[], id: string): {
    nodes: Node[];
    removed?: Node;
} { let removed: Node | undefined; const next: Node[] = []; for (const n of nodes) {
    if (n.id === id) {
        removed = n;
        continue;
    }
    if (n.children) {
        const r = remove(n.children, id);
        if (r.removed)
            removed = r.removed;
        next.push({ ...n, children: r.nodes });
    }
    else
        next.push(n);
} return { nodes: next, removed }; }
function firstColumn(nodes: Node[]): Node | undefined { for (const n of nodes) {
    if (n.kind === "column")
        return n;
    const f = n.children && firstColumn(n.children);
    if (f)
        return f;
} }
function contains(nodes: Node[] | undefined, id: string): boolean { return Boolean(nodes?.some(n => n.id === id || contains(n.children, id))); }
function columnForTarget(nodes: Node[], targetId: string): Node | undefined {
    const target = find(nodes, targetId);
    if (!target)
        return firstColumn(nodes);
    if (target.kind === "column")
        return target;
    if (target.kind === "section" || target.kind === "row")
        return firstColumn(target.children || []) || firstColumn(nodes);
    let parent = findParent(nodes, targetId);
    while (parent) {
        if (parent.kind === "column")
            return parent;
        parent = findParent(nodes, parent.id);
    }
    return firstColumn(nodes);
}
function accepts(parent: Node, child: Node) { return parent.kind === "section" ? child.kind === "row" : parent.kind === "row" ? child.kind === "column" : parent.kind === "column" ? child.kind !== "section" && child.kind !== "column" : false; }
function append(nodes: Node[], parentId: string, child: Node) { return map(nodes, parentId, n => accepts(n, child) ? { ...n, children: [...(n.children || []), child] } : n); }
function newColumn(width = 100): Node { return { id: uid("column"), kind: "column", padding: 18, background: "#fff", visible: true, width, children: [] }; }
function newRow(cols: number, widths?: number[]): Node { const ratios = widths || Array.from({ length: cols }, () => Math.round(100 / cols)); return { id: uid("row"), kind: "row", gap: 12, stackMobile: true, visible: true, children: ratios.map(newColumn) }; }
function newSection(): Node { return { id: uid("section"), kind: "section", name: "Section", background: "#ffffff", visible: true, children: [newRow(1, [100])] }; }
function newLayout(kind: LayoutKind): Node { const spec = layoutSpecs[kind]; return newRow(spec.widths.length, spec.widths); }
function blankDoc(current: Doc, l: Locale): Doc { const section = newSection(); section.name = tr(l, "Nội dung mới", "New content"); return { title: tr(l, "Email chưa đặt tên", "Untitled email"), variables: clone(current.variables), theme: { ...defaultTheme, ...current.theme }, nodes: [section] }; }
function newLeaf(kind: Leaf, l: Locale): Node { const b: Node = { id: uid(kind), kind, visible: true, padding: 14, align: "left", textColor: "#30463d", accent: "#173f33", radius: 8 }; if (kind === "heading")
    return { ...b, headingLevel: 2, fontSize: 28, lineHeight: 1.2, fontWeight: 700, content: tr(l, "Tiêu đề phần mới", "New section heading") }; if (kind === "text")
    return { ...b, fontSize: 14, lineHeight: 1.6, fontWeight: 400, content: tr(l, "Nhập nội dung của bạn tại đây.", "Write your content here.") }; if (kind === "button")
    return { ...b, content: tr(l, "Nút hành động", "Call to action"), align: "center", href: "", linkTitle: "", textColor: "#fff", buttonVariant: "solid", buttonSize: "md", buttonWidth: "auto", buttonIcon: "none" }; if (kind === "image")
    return { ...b, src: "", alt: "", caption: "", href: "", maxWidth: 100, objectFit: "contain" }; if (kind === "banner")
    return { ...b, src: "", mobileSrc: "", alt: "", href: "", maxWidth: 100, objectFit: "cover" }; if (kind === "logo")
    return { ...b, content: "ALTA", src: "https://alta-s3.dev-altamedia.com/public/local-alta.png", assetId: "logo-alta", alt: "Altasoftware", href: "https://altasoftware.vn", align: "center", height: 36 }; if (kind === "social")
    return { ...b, align: "center", socialStyle: "circle", socialSize: 32, social: [{ id: uid("soc"), platform: "facebook", url: "", label: "Facebook", enabled: true }, { id: uid("soc"), platform: "linkedin", url: "", label: "LinkedIn", enabled: true }] }; if (kind === "table")
    return { ...b, table: defaultTable() }; if (kind === "divider")
    return { ...b, height: 1, padding: 12, accent: "#dbe5e0" }; if (kind === "spacer")
    return { ...b, height: 32, padding: 0 }; if (kind === "contact")
    return { ...b, content: "hr@altasoftware.vn · (+84) 28 3999 0000", contact: { name: "", role: "", email: "hr@altasoftware.vn", phone: "(+84) 28 3999 0000", address: "" }, fontSize: 12, lineHeight: 1.6, align: "center" }; if (kind === "preheader")
    return { ...b, content: tr(l, "Nội dung xem trước trong hộp thư người nhận", "Inbox preview text"), fontSize: 11 }; return { ...b, html: '<table role="presentation" width="100%"><tr><td class="custom-card"><strong>Nội dung tùy chỉnh</strong></td></tr></table>', css: '.custom-card { padding: 24px; color: #173f33; }' }; }
function rekeyNode(n: Node): Node { return { ...clone(n), id: uid(n.kind), children: n.children?.map(rekeyNode), social: n.social?.map(s => ({ ...s, id: uid("soc") })) }; }
function elementCount(n: Node): number { return ["section", "row", "column"].includes(n.kind) ? (n.children || []).reduce((sum, c) => sum + elementCount(c), 0) : 1; }
function nodeName(n: Node, l: Locale) { const names: Record<Kind, [
    string,
    string
]> = { section: ["Section", "Section"], row: ["Hàng", "Row"], column: ["Cột", "Column"], text: ["Đoạn văn", "Paragraph"], heading: ["Tiêu đề", "Heading"], button: ["Nút bấm", "Button"], image: ["Hình ảnh", "Image"], banner: ["Banner", "Banner"], logo: ["Logo", "Logo"], social: ["Mạng xã hội", "Social links"], table: ["Bảng dữ liệu", "Data table"], divider: ["Đường ngăn", "Divider"], spacer: ["Khoảng cách", "Spacer"], contact: ["Liên hệ", "Contact"], preheader: ["Preheader", "Preheader"], custom: ["HTML/CSS", "HTML/CSS"] }; return n.name || tr(l, ...names[n.kind]); }
function responsibility(n: Node, l: Locale) { const roles: Record<Kind, [
    string,
    string
]> = { section: ["Nhóm các hàng thành một vùng nội dung", "Groups rows into a content region"], row: ["Phân chia nội dung theo tỷ lệ cột", "Distributes content across columns"], column: ["Chứa và căn các block nội dung", "Contains and aligns content blocks"], text: ["Trình bày nội dung đọc chính", "Carries the main readable copy"], heading: ["Tạo phân cấp và điểm quét nội dung", "Creates hierarchy and scan points"], button: ["Điều hướng tới một hành động rõ ràng", "Drives one clear action"], image: ["Minh họa và cung cấp ngữ cảnh", "Illustrates and adds context"], banner: ["Truyền tải thông điệp chủ đạo toàn chiều rộng", "Carries a full-width campaign message"], logo: ["Nhận diện thương hiệu đã được duyệt", "Shows an approved brand identity"], social: ["Điều hướng tới các kênh chính thức", "Links to official social channels"], table: ["Trình bày dữ liệu có cấu trúc", "Presents structured data"], divider: ["Phân tách các nhóm nội dung", "Separates content groups"], spacer: ["Tạo nhịp thở theo chiều dọc", "Creates vertical rhythm"], contact: ["Cung cấp thông tin liên hệ có thể bấm", "Provides actionable contact details"], preheader: ["Tạo dòng xem trước trong hộp thư", "Controls inbox preview text"], custom: ["Chứa mã email không thể dựng bằng block", "Hosts email code not covered by blocks"] }; return tr(l, ...roles[n.kind]); }
function tokens(content: string, vars: Variable[]) { const out: {
    text: string;
    key?: string;
    raw: string;
}[] = []; let at = 0; for (const m of content.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    const i = m.index || 0;
    if (i > at)
        out.push({ text: content.slice(at, i), raw: content.slice(at, i) });
    out.push({ text: vars.find(v => v.key === m[1])?.fallback || m[1], key: m[1], raw: m[0] });
    at = i + m[0].length;
} if (at < content.length)
    out.push({ text: content.slice(at), raw: content.slice(at) }); return out; }
const safeUrl = (u = "") => { const value = u.trim(); if (!value)
    return ""; if (/^\{\{\s*[a-zA-Z0-9_.]+\s*\}\}$/.test(value))
    return value; if (/^(javascript|vbscript|data|file):/i.test(value))
    return ""; if (/^(https?:|mailto:|tel:|cid:)/i.test(value))
    return value; return ""; };
const safeResourceUrl = (u = "") => { const value = u.trim(); if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(value)) return value; return safeUrl(value); };
const escapeHtml = (s = "") => s.replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
const neutralizeFetches = (s = "") => s.replace(/<([a-z][^<>]*?)>/gis, tag => tag.replace(/\s(src|srcset|href|poster|background)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (match, name) => match.replace(new RegExp(`\\b${name}\\b`, "i"), `data-mc-original-${name}`)));
const readAttr = (el: Element, name: string) => el.getAttribute(name) || el.getAttribute(`data-mc-original-${name}`) || "";
const cssPropertyAllowed = (name: string) => !/^(behavior|binding|position|z-index|filter|transform|animation|transition|content|counter|mso-|v\:|--)/i.test(name);
const cleanCss = (s = "") => s.split(/(?<=;|\})/).filter(part => !/@import|expression\s*\(|javascript:|vbscript:|data:text\/html/i.test(part)).map(part => part.replace(/\b(url\s*\([^)]*\))/gi, match => /url\s*\(\s*["']?(?:https?:|data:image\/|cid:)/i.test(match) ? match : "")).join("");
function sanitizeFragment(s = "") {
    if (typeof DOMParser === "undefined")
        return s.replace(/<script[\s\S]*?<\/script>|<iframe[\s\S]*?<\/iframe>|<form[\s\S]*?<\/form>/gi, "").replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    const doc = new DOMParser().parseFromString(`<body>${neutralizeFetches(s)}</body>`, "text/html"), dangerous = "script,form,iframe,object,embed,svg,math,canvas,video,audio,source,link,meta,base";
    doc.body.querySelectorAll(dangerous).forEach(el => el.remove());
    doc.body.querySelectorAll("*").forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase(), original = name.startsWith("data-mc-original-") ? name.slice(17) : name;
            if (/^on/i.test(name) || name === "srcdoc" || /^data-mc-original-(on|srcdoc)/i.test(name)) {
                el.removeAttribute(attr.name);
                return;
            }
            if (["src", "srcset", "href", "poster", "background"].includes(original)) {
                const value = attr.value.trim(), allowRelative = (v: string) => /^(?:\.\.?\/|\/)[^\s"'<>]*$/.test(v) ? v : (original === "href" ? safeUrl(v) : safeResourceUrl(v)), safe = original === "srcset" ? value.split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean).map(allowRelative).filter(Boolean).join(", ") : allowRelative(value);
                el.removeAttribute(attr.name);
                if (safe)
                    el.setAttribute(original, safe);
                return;
            }
            if (name === "style") {
                const css = cleanCss(attr.value);
                if (css)
                    el.setAttribute("style", css);
                else
                    el.removeAttribute("style");
            }
        });
    });
    return doc.body.innerHTML;
}
const cleanHtml = (s = "") => sanitizeFragment(s);
function scopeCss(css: string, scope: string) {
    const safe = cleanCss(css);
    return safe.replace(/(^|\})(\s*[^@{}][^{}]*)\{([^{}]*)\}/g, (_m, prefix, selectors, declarations) => {
        const filtered = declarations.split(";").map((d: string) => d.trim()).filter((d: string) => { const i = d.indexOf(":"); return i > 0 && cssPropertyAllowed(d.slice(0, i).trim()); }).join(";");
        if (!filtered)
            return `${prefix}`;
        const scoped = selectors.split(",").map((sel: string) => { const clean = sel.trim(); return /^(html|body|:root)$/i.test(clean) ? scope : `${scope} ${clean}`; }).join(", ");
        return `${prefix}${scoped}{${filtered}}`;
    });
}
const surfaceBackground = (n: Node) => n.backgroundMode === "gradient" ? `linear-gradient(${n.gradientAngle || 135}deg,${n.background || "#ffffff"} 0%,${n.gradientTo || "#e9f3ee"} 100%)` : n.background || "#ffffff";
const surfaceShadow = (n: Node) => n.elevation === "soft" ? `0 8px 18px ${n.shadowColor || "#c4d0ca"}` : n.elevation === "strong" ? `0 14px 28px ${n.shadowColor || "#9eafa7"}` : n.elevation === "inset" ? `inset 0 0 0 2px ${n.shadowColor || "#dce6e1"}` : "none";
const paddingCss = (n: Node) => `${n.paddingTop ?? n.padding ?? 0}px ${n.paddingRight ?? n.padding ?? 0}px ${n.paddingBottom ?? n.padding ?? 0}px ${n.paddingLeft ?? n.padding ?? 0}px`;
const marginCss = (n: Node) => `${n.marginTop ?? n.padding ?? 0}px ${n.marginRight ?? 0}px ${n.marginBottom ?? n.padding ?? 0}px ${n.marginLeft ?? 0}px`;
function inlineHtml(items: InlineNode[] | undefined, fallback: string) { if (!items?.length)
    return escapeHtml(fallback).replace(/\n/g, "<br>"); const render = (item: InlineNode): string => { const body = item.type === "text" ? escapeHtml(item.text || "").replace(/\n/g, "<br>") : item.type === "br" ? "<br>" : (item.children || []).map(render).join(""); if (item.type === "link")
        return safeUrl(item.href) ? `<a href="${escapeHtml(item.href)}"${item.title ? ` title="${escapeHtml(item.title)}"` : ""}>${body}</a>` : body; if (item.type === "strong")
        return `<strong>${body}</strong>`; if (item.type === "em")
        return `<em>${body}</em>`; if (item.type === "span")
        return `<span>${body}</span>`; return body; }; return items.map(render).join(""); }
function htmlNode(n: Node): string { if (n.visible === false)
    return ""; const kids = (n.children || []).map(htmlNode).join(""); if (n.kind === "section")
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${n.background || "#fff"}"><tr><td>${kids}</td></tr></table>`; if (n.kind === "row")
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${kids}</tr></table>`; if (n.kind === "column")
    return `<td width="${n.width || 100}%" valign="top" style="width:${n.width || 100}%;padding:${paddingCss(n)};background:${n.background || "#fff"}">${kids}</td>`; const a = n.align || "left", p = n.padding || 0; if (n.kind === "heading") {
    const h = n.headingLevel || 2;
    return `<h${h} style="margin:${marginCss(n)};color:${n.textColor};text-align:${a};font-family:${n.fontFamily || "Georgia,serif"};font-size:${n.fontSize || 28}px;line-height:${n.lineHeightRaw || n.lineHeight || 1.2};font-weight:${n.fontWeight || 700}">${inlineHtml(n.inline, n.content || "")}</h${h}>`;
} if (n.kind === "preheader")
    return `<div style="display:none!important;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(n.content)}</div>`; if (["text", "contact"].includes(n.kind))
    return `<p style="margin:${marginCss(n)};color:${n.textColor};text-align:${a};font-size:${n.fontSize || 14}px;line-height:${n.lineHeightRaw || n.lineHeight || 1.6};font-weight:${n.fontWeight || 400}">${inlineHtml(n.inline, n.content || "")}</p>`; if (n.kind === "button") {
    const href = safeUrl(n.href), tag = href ? `a href="${escapeHtml(href)}"` : "span";
    return `<table role="presentation" align="${a}"><tr><td style="padding:${p}px 0"><${tag}${n.linkTitle ? ` title="${escapeHtml(n.linkTitle)}"` : ""} style="display:inline-block;padding:12px 20px;border-radius:${n.radius}px;background:${n.accent};color:${n.textColor};text-decoration:none">${escapeHtml(n.content)}</${href ? "a" : "span"}></td></tr></table>`;
} if (n.kind === "image" || n.kind === "banner") {
    if (!n.src)
        return "";
    const img = `<img src="${escapeHtml(n.src)}" alt="${escapeHtml(n.alt)}" width="${n.maxWidth || 100}%" style="display:block;max-width:${n.maxWidth || 100}%;height:auto;border-radius:${n.radius}px;margin:${a === "center" ? "0 auto" : a === "right" ? "0 0 0 auto" : "0"}">`, linked = safeUrl(n.href) ? `<a href="${escapeHtml(n.href)}">${img}</a>` : img, caption = n.kind === "image" && n.caption ? `<p style="margin:8px 0 0;color:#68766f;font-size:12px;text-align:${a}">${escapeHtml(n.caption)}</p>` : "";
    return linked + caption;
} if (n.kind === "logo") {
    const logo = n.src ? `<img src="${escapeHtml(n.src)}" alt="${escapeHtml(n.alt || n.content || "Logo")}" height="${n.height || 36}" style="display:inline-block;height:${n.height || 36}px;width:auto">` : `<span style="font:700 ${n.height || 36}px Georgia;color:${n.accent}">${escapeHtml(n.content || "ALTA")}</span>`;
    return `<p style="text-align:${a};margin:${p}px 0">${safeUrl(n.href) ? `<a href="${escapeHtml(n.href)}">${logo}</a>` : logo}</p>`;
} if (n.kind === "social")
    return `<p style="text-align:${a}">${(n.social || []).filter(x => x.enabled && safeUrl(x.url)).map(x => `<a href="${escapeHtml(x.url)}" aria-label="${escapeHtml(x.label || x.platform)}" title="${escapeHtml(x.label || x.platform)}" style="margin:0 6px;color:${n.accent}">${x.platform}</a>`).join("")}</p>`; if (n.kind === "table" && n.table) {
    const t = n.table;
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${t.caption ? `<caption style="padding:0 0 8px;text-align:${t.align};font-weight:700">${escapeHtml(t.caption)}</caption>` : ""}${t.cells.map((r, ri) => `<tr>${r.map(c => `<${t.header && ri === 0 ? "th" : "td"} style="padding:${t.cellPadding}px;border:1px solid ${t.borderColor};background:${t.header && ri === 0 ? t.headerBg : t.zebra && ri % 2 === 0 ? t.altBg : t.rowBg};color:${t.header && ri === 0 ? t.headerColor : "#30463d"};text-align:${t.align}">${escapeHtml(c)}</${t.header && ri === 0 ? "th" : "td"}>`).join("")}</tr>`).join("")}</table>`;
} if (n.kind === "divider")
    return `<hr style="border:0;border-top:${n.height}px solid ${n.accent};margin:${p}px 0">`; if (n.kind === "spacer")
    return `<div style="height:${n.height}px">&nbsp;</div>`; if (n.kind === "custom")
    return `<style>${cleanCss(n.css)}</style>${cleanHtml(n.html)}`; return ""; }
function exportNode(n: Node): string {
    if (n.visible === false)
        return "";
    const kids = (n.children || []).map(exportNode).join("");
    if (n.kind === "section") {
        const fallback = n.background || "#ffffff", gradient = n.backgroundMode === "gradient" ? `;background-image:${surfaceBackground(n)}` : "";
        return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="${fallback}" style="background-color:${fallback}${gradient};border:${n.borderWidth || 0}px solid ${n.borderColor || "transparent"};border-radius:${n.radius || 0}px;box-shadow:${surfaceShadow(n)}"><tr><td>${kids}</td></tr></table>`;
    }
    if (n.kind === "row")
        return `<table role="presentation" class="mc-row${n.stackMobile !== false ? " mc-stack" : ""}" width="100%" cellspacing="0" cellpadding="0"><tr>${kids}</tr></table>`;
    if (n.kind === "column") {
        const fallback = n.background || "#ffffff", gradient = n.backgroundMode === "gradient" ? `;background-image:${surfaceBackground(n)}` : "";
        return `<td class="mc-column" width="${n.width || 100}%" valign="top" bgcolor="${fallback}" style="width:${n.width || 100}%;padding:${paddingCss(n)};background-color:${fallback}${gradient};border:${n.borderWidth || 0}px solid ${n.borderColor || "transparent"};border-radius:${n.radius || 0}px;box-shadow:${surfaceShadow(n)}">${kids}</td>`;
    }
    if (n.kind === "heading" || n.kind === "text") {
        const tag = n.kind === "heading" ? `h${n.headingLevel || 2}` : "p", style = `margin:${marginCss(n)};color:${n.textColor || "inherit"};text-align:${n.align || "left"};font-family:${n.fontFamily || "inherit"};font-size:${n.fontSize || (n.kind === "heading" ? 28 : 14)}px;line-height:${n.lineHeightRaw || n.lineHeight || 1.5};font-weight:${n.fontWeight || (n.kind === "heading" ? 700 : 400)};font-style:${n.italic ? "italic" : "normal"};letter-spacing:${n.letterSpacing || 0}px;text-transform:${n.textTransform || "none"}`;
        return `<${tag} style="${style}">${inlineHtml(n.inline, n.content || "")}</${tag}>`;
    }
    if (n.kind === "contact" && n.contact) {
        const c = n.contact, top = [c.name, c.role].filter(Boolean).map(escapeHtml).join(" · "), email = c.email ? `<a href="mailto:${escapeHtml(c.email)}" style="color:inherit">${escapeHtml(c.email)}</a>` : "", phone = c.phone ? `<a href="tel:${escapeHtml(c.phone.replace(/[^+\d{}a-zA-Z_]/g, ""))}" style="color:inherit">${escapeHtml(c.phone)}</a>` : "", actions = [email, phone].filter(Boolean).join(" · "), body = [top, actions, c.address && escapeHtml(c.address)].filter(Boolean).join("<br>");
        return `<p style="margin:${marginCss(n)};color:${n.textColor};text-align:${n.align || "left"};font-family:${n.fontFamily || "inherit"};font-size:${n.fontSize || 12}px;line-height:${n.lineHeightRaw || n.lineHeight || 1.6};font-style:${n.italic ? "italic" : "normal"};letter-spacing:${n.letterSpacing || 0}px;text-transform:${n.textTransform || "none"}">${body}</p>`;
    }
    if (n.kind === "button") {
        const href = safeUrl(n.href), size = n.buttonSize === "sm" ? "9px 14px" : n.buttonSize === "lg" ? "15px 26px" : "12px 20px", variant = n.buttonVariant || "solid", bg = variant === "solid" ? n.accent : variant === "soft" ? `${n.accent}18` : "transparent", color = variant === "solid" ? n.textColor : n.accent, border = variant === "outline" ? `1px solid ${n.accent}` : "0", label = `${n.buttonIcon === "left" ? "← " : ""}${escapeHtml(n.content)}${n.buttonIcon === "right" ? " →" : ""}`;
        return `<table role="presentation" width="${n.buttonWidth === "full" ? "100%" : "auto"}" align="${n.align || "left"}"><tr><td style="padding:${n.padding || 0}px 0"><a href="${escapeHtml(href)}"${n.linkTitle ? ` title="${escapeHtml(n.linkTitle)}"` : ""} style="display:block;padding:${size};border:${border};border-radius:${n.radius || 0}px;background:${bg};color:${color};text-align:center;text-decoration:${variant === "link" ? "underline" : "none"}">${label}</a></td></tr></table>`;
    }
    if (n.kind === "banner") {
        if (!n.src)
            return "";
        const img = `<img src="${escapeHtml(n.src)}" alt="${escapeHtml(n.alt)}" width="100%" style="display:block;width:100%;max-width:100%;height:auto;border-radius:${n.radius || 0}px">`;
        return safeUrl(n.href) ? `<a href="${escapeHtml(n.href)}">${img}</a>` : img;
    }
    if (n.kind === "table" && n.table) {
        const t = n.table;
        return `<table width="100%" cellspacing="0" cellpadding="0">${t.caption ? `<caption style="padding:0 0 8px;text-align:${t.align};font-weight:700">${escapeHtml(t.caption)}</caption>` : ""}${t.cells.map((r, ri) => `<tr>${r.map((c, ci) => { const explicitTag = t.cellTags?.[ri]?.[ci], isColumnHeader = explicitTag ? explicitTag === "th" : t.header && ri === 0, isRowHeader = !explicitTag && t.headerColumn && ci === 0, tag = isColumnHeader || isRowHeader ? "th" : "td", scope = isColumnHeader ? ' scope="col"' : isRowHeader ? ' scope="row"' : "", cell = t.cellStyles?.[ri]?.[ci] || {}, bg = cell.background || (isColumnHeader || isRowHeader ? t.headerBg : t.zebra && ri % 2 === 0 ? t.altBg : t.rowBg), color = cell.textColor || (isColumnHeader || isRowHeader ? t.headerColor : "#30463d"); return `<${tag}${scope} style="padding:${paddingCss(cell as Node)};border:1px solid ${cell.borderColor || t.borderColor};background:${bg};color:${color};text-align:${cell.align || t.align}">${inlineHtml(undefined, c)}</${tag}>`; }).join("")}</tr>`).join("")}</table>`;
    }
    return htmlNode(n);
}
const exportHtml = (d: Doc) => { const theme = { ...defaultTheme, ...d.theme }; return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media(max-width:600px){.mc-stack .mc-column{display:block!important;width:100%!important}}</style></head><body style="margin:0;background:${theme.outerBg};font-family:${theme.fontFamily};font-size:${theme.baseFontSize}px"><table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="${theme.width}" style="width:100%;max-width:${theme.width}px;background:${theme.contentBg}">${d.nodes.map(exportNode).join("")}</table></td></tr></table></body></html>`; };
function review(d: Doc) { const out: {
    level: "error" | "warn";
    title: string;
    detail: string;
    nodeId?: string;
}[] = []; const walk = (ns: Node[]) => ns.forEach(n => { if ((n.kind === "image" || n.kind === "banner") && !n.alt?.trim())
    out.push({ level: "error", title: "Ảnh thiếu mô tả", detail: "Thêm alt text để email vẫn rõ khi hộp thư chặn ảnh.", nodeId: n.id }); if (n.kind === "button" && !safeUrl(n.href))
    out.push({ level: "error", title: "Nút chưa có liên kết", detail: "Đặt URL HTTPS, mailto hoặc tel trước khi xuất bản.", nodeId: n.id }); if (n.kind === "social")
    (n.social || []).filter(x => x.enabled && !safeUrl(x.url)).forEach(() => out.push({ level: "warn", title: "Mạng xã hội thiếu URL", detail: "Điền URL hoặc tắt nền tảng chưa dùng.", nodeId: n.id })); if (n.kind === "preheader" && (n.content?.length || 0) > 110)
    out.push({ level: "warn", title: "Preheader hơi dài", detail: "Nên giữ dưới 110 ký tự.", nodeId: n.id }); if ((n.kind === "image" || n.kind === "banner") && n.href && !safeUrl(n.href))
    out.push({ level: "error", title: "Liên kết ảnh không hợp lệ", detail: "Dùng URL HTTPS, mailto hoặc tel.", nodeId: n.id }); if (n.kind === "logo" && !n.alt?.trim())
    out.push({ level: "warn", title: "Logo thiếu tên thay thế", detail: "Thêm alt text nhận diện thương hiệu.", nodeId: n.id }); if (n.kind === "logo" && n.href && !safeUrl(n.href))
    out.push({ level: "error", title: "Website logo không hợp lệ", detail: "Dùng URL HTTPS hợp lệ.", nodeId: n.id }); if (n.kind === "social")
    (n.social || []).filter(x => x.enabled && !x.label?.trim()).forEach(() => out.push({ level: "warn", title: "Kênh xã hội thiếu nhãn", detail: "Thêm nhãn truy cập cho biểu tượng mạng xã hội.", nodeId: n.id })); if (n.kind === "table" && !n.table?.caption.trim())
    out.push({ level: "warn", title: "Bảng thiếu mô tả", detail: "Thêm tên hoặc mô tả ngắn cho bảng.", nodeId: n.id }); if (n.kind === "contact" && !n.contact?.email && !n.contact?.phone)
    out.push({ level: "warn", title: "Liên hệ chưa có kênh hành động", detail: "Thêm email hoặc số điện thoại.", nodeId: n.id }); if (n.kind === "preheader" && !n.content?.trim())
    out.push({ level: "error", title: "Preheader đang trống", detail: "Thêm dòng xem trước cho hộp thư.", nodeId: n.id }); if (n.kind === "custom" && cleanHtml(n.html) !== n.html)
    out.push({ level: "error", title: "HTML có nội dung bị chặn", detail: "Script, form và event handler không được phép.", nodeId: n.id }); if (n.children)
    walk(n.children); }); walk(d.nodes); return out; }
function I({ name }: {
    name: string;
}) { const i: Record<string, string> = { templates: "▦", insert: "＋", reusable: "▣", layers: "▱", variables: "◇", assets: "▧", review: "✓", history: "↶", theme: "◐", import: "⇥", undo: "↶", redo: "↷", preview: "◉", publish: "↑", desktop: "▱", mobile: "▯", drag: "⠿" }; return <span className="v3-icon" aria-hidden>{i[name] || name}</span>; }
function Field({ label, children, hint }: {
    label: string;
    children: React.ReactNode;
    hint?: string;
}) { return <label className="v3-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Toggle({ checked, onChange, label }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
}) { return <label className="v3-toggle"><button type="button" className={checked ? "on" : ""} onClick={() => onChange(!checked)}><i /></button><span>{label}</span></label>; }
export default function Studio() {
    const [locale, setLocale] = useState<Locale>(() => { if (typeof window === "undefined")
        return "vi"; const stored = window.localStorage.getItem("mailcraft-ui-locale"); return stored === "en" ? "en" : "vi"; }), [history, setHistory] = useState<History>({ past: [], present: initial, future: [] }), [selected, setSelected] = useState("heading-1"), [left, setLeft] = useState<"templates" | "blocks" | "reusable" | "layers">("blocks"), [tab, setTab] = useState<"content" | "design" | "advanced">("content"), [panel, setPanel] = useState<Panel>(null), [special, setSpecial] = useState<"theme" | "import" | null>(null), [workspaceExpanded, setWorkspaceExpanded] = useState(() => typeof window !== "undefined" && localStorage.getItem("mailcraft-workspace-size") === "expanded"), [device, setDevice] = useState<Device>("desktop"), [zoom, setZoom] = useState(90), [query, setQuery] = useState(""), [save, setSave] = useState<"saved" | "saving" | "dirty">("saved"), [toast, setToast] = useState(""), [assetTarget, setAssetTarget] = useState<AssetTarget | null>(null), [selection, setSelection] = useState<{
        nodeId: string;
        text: string;
    } | null>(null), [engine, setEngine] = useState(false), [savedBlocks, setSavedBlocks] = useState<SavedBlock[]>(() => { if (typeof window === "undefined")
        return []; try {
        return JSON.parse(localStorage.getItem("mailcraft-saved-blocks") || "[]") as SavedBlock[];
    }
    catch {
        return [];
    } });
    const host = useRef<HTMLDivElement>(null), editor = useRef<GrapesEditor | null>(null), variableCursor = useRef<{
        nodeId: string;
        offset: number;
    } | null>(null), doc = history.present, active = useMemo(() => find(doc.nodes, selected), [doc.nodes, selected]), issues = useMemo(() => review(doc), [doc]), html = useMemo(() => exportHtml(doc), [doc]), initialHtml = useRef(html);
    const note = useCallback((s: string) => { setToast(s); setTimeout(() => setToast(""), 2100); }, []);
    const commit = useCallback((fn: (d: Doc) => Doc) => { setHistory(h => ({ past: [...h.past.slice(-39), h.present], present: fn(clone(h.present)), future: [] })); setSave("dirty"); }, []);
    const patch = (id: string, p: Partial<Node>) => commit(d => ({ ...d, nodes: map(d.nodes, id, n => ({ ...n, ...p })) })), patchTheme = (p: Partial<EmailTheme>) => commit(d => ({ ...d, theme: { ...defaultTheme, ...d.theme, ...p } }));
    useEffect(() => { localStorage.setItem("mailcraft-ui-locale", locale); document.documentElement.lang = locale; }, [locale]);
    useEffect(() => { localStorage.setItem("mailcraft-workspace-size", workspaceExpanded ? "expanded" : "standard"); }, [workspaceExpanded]);
    useEffect(() => { localStorage.setItem("mailcraft-saved-blocks", JSON.stringify(savedBlocks)); }, [savedBlocks]);
    useEffect(() => { if (save !== "dirty")
        return; const a = setTimeout(() => setSave("saving"), 300), b = setTimeout(() => setSave("saved"), 1100); return () => { clearTimeout(a); clearTimeout(b); }; }, [doc, save]);
    useEffect(() => { const theme = { ...defaultTheme, ...doc.theme }, root = document.documentElement; root.style.setProperty("--mc-email-width", `${theme.width}px`); root.style.setProperty("--mc-outer-bg", theme.outerBg); root.style.setProperty("--mc-content-bg", theme.contentBg); root.style.setProperty("--mc-email-font", theme.fontFamily); root.style.setProperty("--mc-base-size", `${theme.baseFontSize}px`); }, [doc.theme]);
    useEffect(() => { const remember = () => { const el = document.activeElement; if ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && typeof el.selectionStart === "number")
        variableCursor.current = { nodeId: selected, offset: el.selectionStart }; }; document.addEventListener("selectionchange", remember); document.addEventListener("keyup", remember); document.addEventListener("click", remember); return () => { document.removeEventListener("selectionchange", remember); document.removeEventListener("keyup", remember); document.removeEventListener("click", remember); }; }, [selected]);
    useEffect(() => { let alive = true, instance: GrapesEditor | null = null; import("grapesjs").then(m => { if (!alive || !host.current)
        return; instance = m.default.init({ container: host.current, height: "1px", width: "1px", storageManager: false, panels: { defaults: [] }, fromElement: false, noticeOnUnload: false }); instance.setComponents(initialHtml.current); editor.current = instance; setEngine(true); }).catch(() => setEngine(false)); return () => { alive = false; instance?.destroy(); editor.current = null; }; }, []);
    useEffect(() => { editor.current?.setComponents(html); }, [html]);
    const undo = () => setHistory(h => { if (!h.past.length)
        return h; setSave("dirty"); return { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] }; }), redo = () => setHistory(h => { if (!h.future.length)
        return h; setSave("dirty"); return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }; });
    const finishAdd = (n: Node, kind: BlockKind) => { setSelected(n.id); setTab("content"); if (kind === "custom")
        setPanel("html"); if (kind === "image" || kind === "banner" || kind === "logo") {
        setAssetTarget({ nodeId: n.id, accept: kind === "logo" ? "logo" : "image", mode: "replace" });
        setPanel("assets");
    }
    else
        note(tr(locale, "Đã thêm thành phần", "Component added")); };
    const add = (kind: BlockKind, target?: string) => { const targetId = target || selected, t = find(doc.nodes, targetId); if (kind === "section") {
        const section = newSection();
        commit(d => ({ ...d, nodes: [...d.nodes, section] }));
        finishAdd(section, kind);
        return;
    } const n = kind in layoutSpecs ? newLayout(kind as LayoutKind) : newLeaf(kind as Leaf, locale); if (t?.kind === "section") {
        if (n.kind === "row")
            commit(d => ({ ...d, nodes: append(d.nodes, t.id, n) }));
        else {
            const row = newRow(1, [100]);
            row.children![0].children = [n];
            commit(d => ({ ...d, nodes: append(d.nodes, t.id, row) }));
        }
        finishAdd(n, kind);
        return;
    } const col = columnForTarget(doc.nodes, targetId); if (!col) {
        note(tr(locale, "Hãy chọn Section, Row hoặc Column để chèn", "Select a Section, Row, or Column to insert"));
        return;
    } commit(d => ({ ...d, nodes: append(d.nodes, col.id, n) })); finishAdd(n, kind); };
    const del = () => { if (!active || active.kind === "section")
        return; commit(d => ({ ...d, nodes: remove(d.nodes, active.id).nodes })); setSelected("section-main"); };
    const duplicate = () => { if (!active)
        return; const n = rekeyNode(active), col = firstColumn(doc.nodes); if (col) {
        commit(d => ({ ...d, nodes: append(d.nodes, col.id, n) }));
        setSelected(n.id);
    } };
    const insertSavedBlock = (id: string, target?: string) => { const saved = savedBlocks.find(x => x.id === id), targetId = target || selected, t = find(doc.nodes, targetId); if (!saved)
        return; const n = rekeyNode(saved.node), parent = t?.kind === "section" ? t : columnForTarget(doc.nodes, targetId); if (!parent)
        return; commit(d => ({ ...d, nodes: append(d.nodes, parent.id, n) })); setSelected(n.id); setTab("content"); note(tr(locale, `Đã chèn khối “${saved.name}”`, `Inserted “${saved.name}” block`)); };
    const saveAsBlock = () => { if (!active || !["row", "column"].includes(active.kind))
        return; const name = prompt(tr(locale, "Tên khối tái sử dụng", "Reusable block name"), active.name || tr(locale, "Khối của tôi", "My block"))?.trim(); if (!name)
        return; const source = active.kind === "row" ? rekeyNode(active) : { id: uid("row"), kind: "row" as const, name, gap: 0, stackMobile: true, visible: true, children: [{ ...rekeyNode(active), width: 100 }] }; source.name = name; setSavedBlocks(items => [{ id: uid("saved"), name, node: source, elements: elementCount(source) }, ...items]); setLeft("reusable"); note(tr(locale, "Đã lưu vào Thư viện khối", "Saved to the Block library")); };
    const renameSavedBlock = (id: string) => { const item = savedBlocks.find(x => x.id === id); if (!item)
        return; const name = prompt(tr(locale, "Đổi tên khối", "Rename block"), item.name)?.trim(); if (name)
        setSavedBlocks(items => items.map(x => x.id === id ? { ...x, name, node: { ...x.node, name } } : x)); };
    const deleteSavedBlock = (id: string) => { if (confirm(tr(locale, "Xóa khối này khỏi thư viện?", "Remove this block from the library?")))
        setSavedBlocks(items => items.filter(x => x.id !== id)); };
    const drop = (e: React.DragEvent, targetId: string) => { e.preventDefault(); e.stopPropagation(); const k = e.dataTransfer.getData("mc/block") as BlockKind, saved = e.dataTransfer.getData("mc/saved"), id = e.dataTransfer.getData("mc/node"); if (k) {
        add(k, targetId);
        return;
    } if (saved) {
        insertSavedBlock(saved, targetId);
        return;
    } if (!id || id === targetId)
        return;
    commit(d => { const source = find(d.nodes, id), target = find(d.nodes, targetId); if (!source || !target || contains(source.children, targetId))
        return d;
        const targetParent = target.kind === "section" && source.kind === "row" ? target : target.kind === "row" && source.kind === "column" ? target : target.kind === "column" ? target : columnForTarget(d.nodes, targetId); if (!targetParent || !accepts(targetParent, source))
            return d;
        const r = remove(d.nodes, id); return r.removed ? { ...d, nodes: append(r.nodes, targetParent.id, r.removed) } : d; }); };
    const dropRoot = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (e.target !== e.currentTarget)
        return; const k = e.dataTransfer.getData("mc/block") as BlockKind, saved = e.dataTransfer.getData("mc/saved"), id = e.dataTransfer.getData("mc/node"); if (k === "section") {
        add("section");
        return;
    } if (k || saved) {
        const section = newSection(), col = firstColumn(section.children || []); if (!col)
            return; if (k)
            col.children = [k in layoutSpecs ? newLayout(k as LayoutKind) : newLeaf(k as Leaf, locale)];
        else {
            const reusable = savedBlocks.find(x => x.id === saved); if (!reusable)
                return; col.children = [rekeyNode(reusable.node)];
        } commit(d => ({ ...d, nodes: [...d.nodes, section] })); setSelected(col.children[0].id); return;
    } if (id) {
        const source = find(doc.nodes, id); if (!source || source.kind !== "section")
            return; commit(d => { const r = remove(d.nodes, id); return r.removed ? { ...d, nodes: [...r.nodes, r.removed] } : d; });
    } };
    const openAssets = (id?: string, forced?: Asset["type"]) => { const candidate = find(doc.nodes, id || selected), compatible = candidate && ["image", "banner", "logo"].includes(candidate.kind); setAssetTarget(compatible ? { nodeId: candidate!.id, accept: forced || (candidate!.kind === "logo" ? "logo" : "image"), mode: "replace" } : { nodeId: null, accept: forced || "all", mode: "insert" }); setPanel("assets"); };
    const pickAsset = (a: Asset) => { const target = assetTarget || { nodeId: null, accept: "all", mode: "insert" }; if (target.accept !== "all" && target.accept !== a.type) {
        note(tr(locale, "Tài nguyên này không phù hợp với khối đang chọn", "This asset is not compatible with the selected component"));
        return;
    } if (target.mode === "replace" && target.nodeId) {
        const n = find(doc.nodes, target.nodeId);
        if (!n)
            return;
        patch(target.nodeId, { assetId: a.id, src: a.src, content: a.type === "logo" ? a.name.split(" — ")[0] : n.content, alt: n.alt || a.name });
        setSelected(target.nodeId);
    }
    else {
        const t = find(doc.nodes, selected), n = newLeaf(a.type === "logo" ? "logo" : "image", locale);
        Object.assign(n, { assetId: a.id, src: a.src, content: a.type === "logo" ? a.name.split(" — ")[0] : n.content, alt: a.name });
        if (t?.kind === "section") {
            const row = newRow(1, [100]);
            row.children![0].children = [n];
            commit(d => ({ ...d, nodes: append(d.nodes, t.id, row) }));
        }
        else {
            const col = columnForTarget(doc.nodes, selected);
            if (!col) {
                note(tr(locale, "Hãy chọn Section, Row hoặc Column để chèn tài nguyên", "Select a Section, Row, or Column before inserting an asset"));
                return;
            }
            commit(d => ({ ...d, nodes: append(d.nodes, col.id, n) }));
        }
        setSelected(n.id);
    } setPanel(null); setAssetTarget(null); note(tr(locale, a.type === "logo" ? "Đã áp dụng logo" : "Đã áp dụng hình ảnh", a.type === "logo" ? "Logo applied" : "Image applied")); };
    const applyTemplate = (preset: TemplatePreset) => { const next = clone(initial), name = tr(locale, preset.vi, preset.en), hero = find(next.nodes, "col-hero"), heading = find(next.nodes, "heading-1"), copy = find(next.nodes, "text-1"); next.title = name; if (hero)
        hero.background = preset.tone === "sage" ? "#dfe9e3" : preset.tone === "sand" ? "#eee2cf" : preset.tone === "blue" ? "#dce6eb" : "#e9dfe7"; if (heading)
        heading.content = preset.id === "newsletter" ? tr(locale, "Chuyện nhà Alta tháng này", "This month at Alta") : preset.id === "townhall" ? tr(locale, "Hẹn gặp bạn tại Town Hall", "See you at Town Hall") : preset.id === "onboarding" ? tr(locale, "Tuần đầu thật dễ dàng, {{ten_nhan_vien}}!", "Your first week made easy, {{ten_nhan_vien}}!") : tr(locale, "Chào mừng {{ten_nhan_vien}}!", "Welcome {{ten_nhan_vien}}!"); if (copy)
        copy.content = tr(locale, preset.descVi, preset.descEn); commit(() => next); setSelected("heading-1"); setLeft("blocks"); note(tr(locale, `Đã áp dụng mẫu “${name}”`, `Applied “${name}” template`)); };
    const createBlank = () => { const next = blankDoc(doc, locale), column = firstColumn(next.nodes); commit(() => next); setSelected(column?.id || next.nodes[0].id); setLeft("blocks"); setPanel(null); setSpecial(null); note(tr(locale, "Đã tạo email trắng sẵn sàng để dựng", "Blank email ready to compose")); };
    const handleBack = () => { if (panel) {
        setPanel(null);
        setAssetTarget(null);
        return;
    } if (special) {
        setSpecial(null);
        return;
    } if (left !== "templates") {
        setLeft("templates");
        note(tr(locale, "Đã quay về Kho mẫu; bản nháp vẫn được giữ", "Returned to Templates; your draft is preserved"));
        return;
    } if (typeof window !== "undefined" && window.history.length > 1)
        window.history.back();
    else
        note(tr(locale, "Bạn đang ở màn hình đầu của Mailcraft", "You are at the start of Mailcraft")); };
    const capture = (n: Node, el: HTMLElement) => { const s = window.getSelection(); if (!s || s.isCollapsed || !el.contains(s.anchorNode))
        return; const text = s.toString().trim(); if (text.length > 1 && !/\{\{/.test(text))
        setSelection({ nodeId: n.id, text }); };
    const parameterize = () => { if (!selection)
        return; const key = prompt(tr(locale, "Mã biến mới (chữ thường, gạch dưới)", "New variable key"), selection.text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")); if (!key || !/[a-z][a-z0-9_]+/.test(key))
        return; commit(d => { const n = find(d.nodes, selection.nodeId); if (!n)
        return d; const v: Variable = { key, name: selection.text, scope: "template", fallback: selection.text, required: false, campaignOverride: true }; return { ...d, variables: d.variables.some(x => x.key === key) ? d.variables : [...d.variables, v], nodes: map(d.nodes, n.id, x => ({ ...x, content: (x.content || "").replace(selection.text, `{{${key}}}`) })) }; }); setSelection(null); note(tr(locale, "Đã tạo biến riêng của template", "Template variable created")); };
    return <div className="v3-app"><div ref={host} className="v3-engine" aria-hidden/>
  <header className="v3-header"><button className="v3-brand" onClick={() => { setPanel(null); setSpecial(null); setLeft("templates"); }}><b>M</b><span>Mailcraft</span></button><div className="v3-doc"><button aria-label={tr(locale, "Quay lại", "Back")} title={tr(locale, "Quay lại", "Back")} onClick={handleBack}>‹</button><div><p><button onClick={() => { const title = prompt(tr(locale, "Tên template", "Template name"), doc.title); if (title?.trim())
        commit(d => ({ ...d, title: title.trim() })); }}>{doc.title}</button><span>{tr(locale, "Bản nháp", "Draft")}</span></p><small className={save}><i />{save === "saved" ? tr(locale, "Đã tự động lưu", "Autosaved") : save === "saving" ? tr(locale, "Đang lưu", "Saving") : tr(locale, "Có thay đổi", "Unsaved")} · v5</small></div></div><div className="v3-head-actions"><span className="v3-history"><button onClick={undo} disabled={!history.past.length}><I name="undo"/></button><button onClick={redo} disabled={!history.future.length}><I name="redo"/></button></span><button onClick={() => setPanel("review")}><I name="review"/>{tr(locale, "Soát nội dung", "Review")}<b>{issues.length}</b></button><button onClick={() => setPanel("preview")}><I name="preview"/>{tr(locale, "Xem trước", "Preview")}</button><button className="primary" onClick={() => setPanel("publish")}><I name="publish"/>{tr(locale, "Xuất bản", "Publish")}</button><button className="v3-lang" onClick={() => setLocale(l => l === "vi" ? "en" : "vi")}>{locale.toUpperCase()}</button><button className="v3-avatar">DC</button></div></header>
  <aside className="v3-rail"><nav><button className={left === "templates" ? "active" : ""} onClick={() => setLeft("templates")}><I name="templates"/><span>{tr(locale, "Kho mẫu", "Library")}</span></button><i className="v3-rail-separator"/><button className={left === "blocks" ? "active" : ""} onClick={() => setLeft("blocks")}><I name="insert"/><span>{tr(locale, "Chèn", "Insert")}</span></button><button className={left === "reusable" ? "active" : ""} onClick={() => setLeft("reusable")}><I name="reusable"/><span>{tr(locale, "Thư viện khối", "Block library")}</span>{savedBlocks.length > 0 && <em>{savedBlocks.length}</em>}</button><button className={left === "layers" ? "active" : ""} onClick={() => setLeft("layers")}><I name="layers"/><span>{tr(locale, "Cấu trúc", "Layers")}</span></button><button onClick={() => setSpecial("theme")}><I name="theme"/><span>{tr(locale, "Chủ đề", "Theme")}</span></button><button onClick={() => setSpecial("import")}><I name="import"/><span>{tr(locale, "Nhập HTML", "Import")}</span></button><button onClick={() => setPanel("variables")}><I name="variables"/><span>{tr(locale, "Biến", "Variables")}</span></button><button onClick={() => openAssets()}><I name="assets"/><span>{tr(locale, "Tài nguyên", "Assets")}</span></button><button onClick={() => setPanel("review")}><I name="review"/><span>{tr(locale, "Soát lỗi", "Review")}</span>{issues.length > 0 && <em>{issues.length}</em>}</button></nav><nav><button onClick={() => setPanel("history")}><I name="history"/><span>{tr(locale, "Lịch sử", "History")}</span></button></nav></aside>
  <main className="v3-work"><aside className="v3-left">{left === "templates" ? <TemplateLibrary locale={locale} apply={applyTemplate} blank={createBlank} manage={() => setPanel("templates")}/> : left === "blocks" ? <Library locale={locale} query={query} setQuery={setQuery} add={add}/> : left === "reusable" ? <ReusableLibrary locale={locale} items={savedBlocks} insert={insertSavedBlock} rename={renameSavedBlock} remove={deleteSavedBlock}/> : <Layers locale={locale} nodes={doc.nodes} selected={selected} setSelected={setSelected} patch={patch} addSection={() => add("section")}/>}</aside><section className="v3-canvas-area"><div className="v3-canvas-tools"><span><button className={device === "desktop" ? "active" : ""} onClick={() => setDevice("desktop")}><I name="desktop"/> Desktop</button><button className={device === "mobile" ? "active" : ""} onClick={() => setDevice("mobile")}><I name="mobile"/> Mobile</button></span><span><button onClick={() => setZoom(z => Math.max(60, z - 10))}>−</button><b>{zoom}%</b><button onClick={() => setZoom(z => Math.min(120, z + 10))}>＋</button></span><small className={engine ? "ready" : ""}><i />{engine ? "GrapesJS Core" : tr(locale, "Đang kết nối engine", "Connecting engine")}</small></div><div className={`v3-canvas ${device}`}><div className="v3-stage" style={{ transform: `scale(${zoom / 100})` }}><div className="v3-email" onDragOver={e => { if (e.target === e.currentTarget) e.preventDefault(); }} onDrop={dropRoot}><Canvas nodes={doc.nodes} vars={doc.variables} locale={locale} device={device} selected={selected} setSelected={setSelected} patch={patch} capture={capture} drop={drop} openAssets={id => openAssets(id)}/></div></div></div></section>{active ? <Inspector node={active} locale={locale} tab={tab} setTab={setTab} patch={p => patch(active.id, p)} openAssets={() => openAssets(active.id)} openVars={() => setPanel("variables")} openHtml={() => setPanel("html")} duplicate={duplicate} remove={del} saveBlock={saveAsBlock} addRow={() => commit(d => ({ ...d, nodes: append(d.nodes, active.id, newRow(2)) }))} addColumn={() => commit(d => ({ ...d, nodes: append(d.nodes, active.id, newColumn()) }))}/> : <aside className="v3-inspector empty">{tr(locale, "Chọn một thành phần", "Select a component")}</aside>}</main>
  {selection && <button className="v3-parameter" onClick={parameterize}>◇ {tr(locale, "Tham số hóa", "Parameterize")} “{selection.text.slice(0, 28)}”</button>}
  {special === "theme" && <ThemeSheet locale={locale} theme={{ ...defaultTheme, ...doc.theme }} patch={patchTheme} close={() => setSpecial(null)} expanded={workspaceExpanded} toggleExpanded={() => setWorkspaceExpanded(v => !v)}/>}
  {special === "import" && <ImportSheet locale={locale} current={doc} close={() => setSpecial(null)} expanded={workspaceExpanded} toggleExpanded={() => setWorkspaceExpanded(v => !v)} apply={next => { commit(() => next); setSelected(next.nodes[0]?.id || ""); setLeft("layers"); setSpecial(null); note(tr(locale, "Đã nhập thành bản nháp có thể chỉnh sửa", "Imported as an editable draft")); }}/>}
  {panel && <Sheet type={panel} locale={locale} close={() => { setPanel(null); setAssetTarget(null); }} expanded={workspaceExpanded} toggleExpanded={() => setWorkspaceExpanded(v => !v)} createBlank={createBlank} doc={doc} issues={issues} html={html} assets={assets} assetTarget={assetTarget} pickAsset={pickAsset} selectIssue={id => { if (id)
        setSelected(id); setPanel(null); }} insertVar={v => { if (!active || !["text", "heading", "button", "preheader"].includes(active.kind)) {
        note(tr(locale, "Chọn đoạn văn, tiêu đề, nút hoặc preheader trước", "Select a paragraph, heading, button, or preheader first"));
        return;
    } const content = active.content || "", saved = variableCursor.current, at = saved?.nodeId === active.id ? Math.max(0, Math.min(content.length, saved.offset)) : content.length; patch(active.id, { content: `${content.slice(0, at)}{{${v.key}}}${content.slice(at)}` }); variableCursor.current = { nodeId: active.id, offset: at + v.key.length + 4 }; setPanel(null); }} applyTemplate={p => { applyTemplate(p); setPanel(null); }} notify={note} active={active} patchActive={p => active && patch(active.id, p)}/>} {toast && <div className="v3-toast"><b>✓</b>{toast}</div>}
 </div>;
}
function ThemeSheet({ locale, theme, patch, close, expanded, toggleExpanded }: {
    locale: Locale;
    theme: EmailTheme;
    patch: (p: Partial<EmailTheme>) => void;
    close: () => void;
    expanded: boolean;
    toggleExpanded: () => void;
}) { return <div className={`v3-sheet-bg sheet-theme ${expanded ? "workspace-expanded" : ""}`} onMouseDown={e => e.target === e.currentTarget && close()}><aside className="v3-sheet"><header><span className="v3-sheet-icon">◐</span><div><b>{tr(locale, "Chủ đề toàn email", "Email theme")}</b><small>{tr(locale, "Một nguồn thiết lập cho canvas, preview và HTML xuất ra", "One source for canvas, preview, and exported HTML")}</small></div><button className="v3-workspace-size" title={expanded ? tr(locale, "Thu về kích thước chuẩn", "Use standard width") : tr(locale, "Mở rộng không gian làm việc", "Expand workspace")} onClick={toggleExpanded}>{expanded ? "↘" : "↗"}</button><button onClick={close}>×</button></header><div className="v3-sheet-body v3-theme-work"><div className="v3-theme-preview"><span style={{ background: theme.outerBg }}><i style={{ width: `${theme.width / 8}px`, background: theme.contentBg, fontFamily: theme.fontFamily, fontSize: Math.max(8, theme.baseFontSize - 4) }}>Aa</i></span><div><b>{theme.width}px</b><small>{theme.fontFamily.split(",")[0]} · {theme.baseFontSize}px</small></div></div><div className="v3-theme-grid"><Group title={tr(locale, "Khung email", "Email frame")}><Field label={tr(locale, "Chiều rộng nội dung", "Content width")}><Segment values={["600", "640", "720"]} value={String(theme.width)} set={v => patch({ width: +v as EmailTheme["width"] })}/></Field><Field label={tr(locale, "Nền bên ngoài", "Outer background")}><Color value={theme.outerBg} set={v => patch({ outerBg: v })}/></Field><Field label={tr(locale, "Nền nội dung", "Content background")}><Color value={theme.contentBg} set={v => patch({ contentBg: v })}/></Field></Group><Group title={tr(locale, "Chữ mặc định", "Default typography")}><Field label={tr(locale, "Họ phông chữ", "Font family")}><select value={theme.fontFamily} onChange={e => patch({ fontFamily: e.target.value })}><option value="Arial, Helvetica, sans-serif">Arial</option><option value="Georgia, 'Times New Roman', serif">Georgia</option><option value="Tahoma, Arial, sans-serif">Tahoma</option><option value="'Courier New', monospace">Courier New</option></select></Field><Field label={`${tr(locale, "Cỡ chữ cơ sở", "Base font size")} · ${theme.baseFontSize}px`}><input type="range" min="12" max="18" value={theme.baseFontSize} onChange={e => patch({ baseFontSize: +e.target.value })}/></Field><p>{tr(locale, "Block có thiết lập riêng vẫn được ưu tiên hơn chủ đề.", "Component overrides still take priority over the theme.")}</p></Group></div></div></aside></div>; }
const px = (value: string, fallback = 0) => { const n = parseFloat(value); return Number.isFinite(n) ? n : fallback; };
function expandBox(value: string, fallback = 0) { const values = value.trim().split(/\s+/).filter(Boolean).map(v => px(v, fallback)); if (!values.length)
    return { top: fallback, right: fallback, bottom: fallback, left: fallback }; if (values.length === 1)
    return { top: values[0], right: values[0], bottom: values[0], left: values[0] }; if (values.length === 2)
    return { top: values[0], right: values[1], bottom: values[0], left: values[1] }; if (values.length === 3)
    return { top: values[0], right: values[1], bottom: values[2], left: values[1] }; return { top: values[0], right: values[1], bottom: values[2], left: values[3] }; }
const parseWeight = (value: string) => { const n = parseInt(value, 10); return Number.isFinite(n) ? n : /^bold|bolder$/i.test(value) ? 700 : /^normal|lighter$/i.test(value) ? 400 : undefined; };
function styleFrom(el: HTMLElement): Partial<Node> { const s = el.style, weight = parseWeight(s.fontWeight || ""), pad = expandBox(s.padding || `${s.paddingTop || 0} ${s.paddingRight || 0} ${s.paddingBottom || 0} ${s.paddingLeft || 0}`), margin = expandBox(s.margin || `${s.marginTop || 0} ${s.marginRight || 0} ${s.marginBottom || 0} ${s.marginLeft || 0}`), gradient = (s.background || "").match(/linear-gradient\(\s*(\d+)deg\s*,\s*([^,\s]+)[^,]*,\s*([^\s)]+)\s*\)/i); return { background: s.backgroundColor || (gradient ? gradient[2] : s.background) || undefined, backgroundMode: gradient ? "gradient" : undefined, gradientAngle: gradient ? +gradient[1] : undefined, gradientTo: gradient ? gradient[3] : undefined, textColor: s.color || undefined, fontSize: px(s.fontSize) || undefined, lineHeight: px(s.lineHeight) || undefined, lineHeightRaw: s.lineHeight || undefined, fontWeight: weight, fontWeightRaw: s.fontWeight || undefined, fontFamily: s.fontFamily || undefined, letterSpacing: px(s.letterSpacing) || undefined, italic: s.fontStyle === "italic", textTransform: (s.textTransform as Node["textTransform"]) || undefined, align: (s.textAlign as Align) || undefined, padding: pad.top || undefined, paddingTop: pad.top || undefined, paddingRight: pad.right || undefined, paddingBottom: pad.bottom || undefined, paddingLeft: pad.left || undefined, marginTop: margin.top || undefined, marginRight: margin.right || undefined, marginBottom: margin.bottom || undefined, marginLeft: margin.left || undefined, radius: px(s.borderRadius) || undefined, borderColor: s.borderColor || s.borderTopColor || undefined, borderWidth: px(s.borderWidth || s.borderTopWidth || s.borderBottomWidth) || undefined }; }
function parseImportedEmail(raw: string, locale: Locale, current: Doc): { doc: Doc; report: ImportReport } {
    const parsed = new DOMParser().parseFromString(neutralizeFetches(raw), "text/html"), missing = new Set<string>(), externalAssets = new Set<string>();
    const warnings: string[] = [], dropped: string[] = [], unsupportedCss: string[] = [], cssText = Array.from(parsed.querySelectorAll("style")).map(x => x.textContent || "").join("\n").replace(/\/\*[\s\S]*?\*\//g, ""), cssRules = [...cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m, order) => m[1].split(",").map(selector => ({ selector: selector.trim(), declarations: m[2], order }))).filter(x => !x.selector.startsWith("@"));
    const baseHrefRaw = readAttr(parsed.querySelector("base") || parsed.body, "href"), unsafeElements = Array.from(parsed.querySelectorAll("script,form,iframe,object,embed,svg,canvas,video,audio,source")), unsafeAttrs = Array.from(parsed.querySelectorAll("*")).flatMap(el => Array.from(el.attributes).filter(a => /^on/i.test(a.name) || /^(javascript|vbscript|data:text\/html):/i.test(a.value))), dangerous = unsafeElements.length + unsafeAttrs.length;
    unsafeElements.forEach(el => { dropped.push(`<${el.tagName.toLowerCase()}>`); el.remove(); }); parsed.querySelectorAll("helmet,meta,link,style,base").forEach(x => x.remove());
    const track = (src: string) => { const value = src.trim(); if (!value)
        return; if (/^(https?:|cid:|data:image\/)/i.test(value))
        externalAssets.add(value); else
        missing.add(value); };
    Array.from(cssText.matchAll(/url\(\s*["']?([^\)"']+)["']?\s*\)/gi)).forEach(m => track(m[1]));
    const baseHref = /^(https?:)/i.test(baseHrefRaw) ? baseHrefRaw : "";
    const resolveUrl = (value: string) => { const clean = value.trim(); if (!clean)
        return ""; if (/^(https?:|mailto:|tel:|cid:|data:image\/|\{\{)/i.test(clean))
        return clean; if (baseHref) {
        try { return new URL(clean, baseHref).href; }
        catch { return clean; }
    } return clean; };
    const text = (el: Element) => { const walkText = (n: globalThis.Node): string => n.nodeType === 3 ? n.textContent || "" : n.nodeType === 1 && (n as Element).tagName === "BR" ? "\n" : (Array.from(n.childNodes) as globalThis.Node[]).map(walkText).join(""); return walkText(el).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim(); };
    const simpleMatch = (el: Element, token: string) => { const t = token.replace(/:[^.#\[]+(\([^)]*\))?/g, "").trim(); if (!t)
        return true; const tag = t.match(/^[a-z][\w-]*/i)?.[0]; if (tag && el.tagName.toLowerCase() !== tag.toLowerCase())
        return false; const id = t.match(/#([\w-]+)/)?.[1]; if (id && el.id !== id)
        return false; for (const c of t.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(c[1]))
        return false; const attr = t.match(/\[([^\]=]+)(?:=(["']?)([^\]"']+)\2)?\]/); if (attr && (!el.hasAttribute(attr[1]) || (attr[3] && el.getAttribute(attr[1]) !== attr[3])))
        return false; return true; };
    const matchesSelector = (el: Element, selector: string) => { const parts = selector.replace(/\s*>\s*/g, " ").trim().split(/\s+/).filter(Boolean); let current: Element | null = el; for (let i = parts.length - 1; i >= 0; i--) { if (!current)
            return false; if (simpleMatch(current, parts[i]))
            current = current.parentElement; else { while (current && !simpleMatch(current, parts[i])) current = current.parentElement; if (current)
                current = current.parentElement; else
                return false; } } return true; };
    const specificity = (selector: string) => [ (selector.match(/#/g) || []).length, (selector.match(/[.\[]/g) || []).length, (selector.match(/(^|[ >])([a-z][\w-]*)/gi) || []).length ];
    const declarationsFor = (el: Element) => cssRules.filter(r => { try { return matchesSelector(el, r.selector); } catch { return false; } }).sort((a, b) => { const sa = specificity(a.selector), sb = specificity(b.selector); return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2] || a.order - b.order; }).map(r => r.declarations).join(";");
    cssText.match(/@([\w-]+)/g)?.filter(x => !/^@(media|supports)$/i.test(x)).forEach(x => unsupportedCss.push(x));
    const styleFor = (el: HTMLElement) => { const inherited = ["color", "font-family", "font-size", "line-height", "font-weight", "text-align", "letter-spacing", "text-transform"], chain: HTMLElement[] = []; let cursor: HTMLElement | null = el.parentElement; while (cursor) { chain.unshift(cursor); cursor = cursor.parentElement; } let value = ""; chain.forEach(parent => { const d = declarationsFor(parent); value += `;${d.split(";").filter(x => inherited.includes(x.split(":")[0]?.trim().toLowerCase())).join(";")}`; }); value += `;${declarationsFor(el)};${el.getAttribute("style") || ""}`; const proxy = document.createElement("div"); proxy.setAttribute("style", value); return proxy.style; };
    const nodeStyle = (el: HTMLElement): Partial<Node> => { const s = styleFor(el), proxy = document.createElement("div"); proxy.style.cssText = s.cssText; const out = styleFrom(proxy); return { ...out, background: out.background || el.getAttribute("bgcolor") || undefined, align: out.align || (el.getAttribute("align") as Align) || undefined, borderWidth: px(s.borderWidth || s.borderTopWidth || s.borderBottomWidth), borderColor: s.borderColor || s.borderTopColor || undefined, radius: px(s.borderRadius) }; };
    const inlineFrom = (el: Element): InlineNode[] => { const walk = (node: globalThis.Node): InlineNode[] => { if (node.nodeType === 3) { const value = (node.textContent || "").replace(/[ \t\r\n]+/g, " "); return value.trim() ? [{ type: "text", text: value }] : []; } if (node.nodeType !== 1)
            return []; const child = Array.from(node.childNodes).flatMap(walk), element = node as HTMLElement, tag = element.tagName; if (tag === "BR")
            return [{ type: "br" }]; if (tag === "A")
            return [{ type: "link", href: safeUrl(readAttr(element, "href")), title: element.getAttribute("title") || undefined, children: child }]; if (tag === "STRONG" || tag === "B")
            return [{ type: "strong", children: child }]; if (tag === "EM" || tag === "I")
            return [{ type: "em", children: child }]; if (tag === "SPAN")
            return [{ type: "span", children: child }]; return child; }; return walk(el); };
    const variablesFound = [...new Set(Array.from(raw.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g), m => m[1]))];
    const allImages = Array.from(parsed.querySelectorAll("img")); let preservedBlocks = 0;
    const imageNode = (img: HTMLImageElement): Node => { const src = resolveUrl(readAttr(img, "src")), style = nodeStyle(img), widthRaw = readAttr(img, "width") || img.style.width || "", width = px(widthRaw), classText = `${img.className} ${src} ${img.alt}`.toLowerCase(), kind: Leaf = /logo|brand/.test(classText) ? "logo" : /hero|banner|cover/.test(classText) || width >= 500 ? "banner" : "image"; track(src); const link = img.closest("a"), node = { ...newLeaf(kind, locale), ...style, src, alt: img.getAttribute("alt") || "", href: link ? safeUrl(resolveUrl(readAttr(link, "href"))) : "", maxWidth: /%$/.test(widthRaw) ? Math.min(100, width) : 100, widthPx: width > 100 ? width : undefined, height: kind === "logo" ? px(readAttr(img, "height")) || 36 : px(readAttr(img, "height")) || undefined, sourceHtml: img.outerHTML }; return node; };
    const customNode = (el: HTMLElement): Node => { const node = newLeaf("custom", locale); preservedBlocks++; return { ...node, strategy: "preserve", fragmentId: node.id, html: sanitizeFragment(el.outerHTML), css: scopeCss(cssText, `[data-mc-fragment="${node.id}"]`), sourceHtml: el.outerHTML }; };
    const textNode = (el: HTMLElement): Node => { const style = nodeStyle(el), inline = inlineFrom(el), heading = /^H[1-4]$/.test(el.tagName) || (style.fontSize || 0) >= 18 || (style.fontWeight || 0) >= 600, kind: Leaf = heading ? "heading" : "text"; return { ...newLeaf(kind, locale), ...style, content: text(el), inline, headingLevel: kind === "heading" ? (/^H[1-4]$/.test(el.tagName) ? Number(el.tagName.slice(1)) as 1 | 2 | 3 | 4 : 2) : undefined, sourceHtml: el.outerHTML }; };
    const buttonNode = (a: HTMLAnchorElement, frame?: HTMLElement): Node => { const frameStyle = nodeStyle(frame || a), style = nodeStyle(a); return { ...newLeaf("button", locale), ...style, content: text(a), href: safeUrl(resolveUrl(readAttr(a, "href"))), linkTitle: a.getAttribute("title") || "", accent: frameStyle.background || style.background || "#173f33", textColor: style.textColor || "#fff", buttonVariant: frameStyle.background || style.background ? "solid" : "outline", sourceHtml: a.outerHTML }; };
    const widthOf = (cell?: HTMLTableCellElement) => { if (!cell) return 0; const styled = styleFor(cell), raw = readAttr(cell, "width") || cell.style.width || styled.width || ""; return px(raw); };
    const distribute = (values: number[], count: number) => { const out = values.slice(0, count), known = out.reduce((a, b) => a + (b > 0 ? b : 0), 0), missingCount = Math.max(0, count - out.filter(x => x > 0).length), each = missingCount ? Math.max(0, (100 - known) / missingCount) : 0; while (out.length < count) out.push(0); const filled = out.map(v => v > 0 ? v : each), total = filled.reduce((a, b) => a + b, 0) || count; return filled.map(v => Math.round(v / total * 100)); };
    const parseTableNode = (table: HTMLTableElement): Node[] => { const trs = Array.from(table.rows), cells = trs.flatMap(row => Array.from(row.cells)), infoTable = Boolean(table.querySelector("caption,th,[role=table]") || table.className.toString().includes("info-card")); if (cells.some(c => c.rowSpan > 1 || c.colSpan > 1)) { dropped.push("table-span"); return [customNode(table)]; } if (infoTable && trs.length > 1) { const cols = Math.max(...trs.map(r => r.cells.length)), model = defaultTable(); model.rows = trs.length; model.cols = cols; model.header = Boolean(table.querySelector("th")); model.headerColumn = Boolean(trs[0]?.cells.some(c => c.tagName === "TH")); model.caption = table.querySelector("caption")?.textContent?.trim() || ""; model.cells = trs.map(r => Array.from(r.cells).map(c => text(c))); model.widths = distribute(Array.from({ length: cols }, (_, i) => widthOf(trs[0]?.cells[i] as HTMLTableCellElement || trs[0]?.cells[0]),), cols); model.cellTags = trs.map(r => Array.from(r.cells).map(c => c.tagName === "TH" ? "th" : "td")); model.cellStyles = trs.map(r => Array.from(r.cells).map(c => nodeStyle(c as HTMLElement))); const st = nodeStyle(table); if (st.background) model.rowBg = st.background; if (st.borderColor) model.borderColor = st.borderColor; return [{ ...newLeaf("table", locale), ...st, table: model, sourceHtml: table.outerHTML }]; }
        return trs.map(row => { const rowCells = Array.from(row.cells).filter(c => !(widthOf(c) > 0 && widthOf(c) <= 5 && !text(c) && !c.querySelector("img,table,a") && !c.getAttribute("style"))); const widths = distribute(rowCells.map(widthOf), rowCells.length); const children = rowCells.map((cell, i) => ({ ...newColumn(widths[i] || Math.round(100 / Math.max(1, rowCells.length))), ...nodeStyle(cell as HTMLElement), children: parseCell(cell as HTMLTableCellElement) })); return { id: uid("row"), kind: "row" as const, gap: 0, stackMobile: true, visible: true, children }; }); };
    const parseCell = (cell: HTMLTableCellElement): Node[] => { const direct = Array.from(cell.children) as HTMLElement[], out: Node[] = [], hasDirectText = Array.from(cell.childNodes).some(n => n.nodeType === 3 && Boolean(n.textContent?.trim())); if (hasDirectText && !direct.some(el => /^(IMG|TABLE|P|H[1-4]|UL|OL|BLOCKQUOTE|HR)$/.test(el.tagName))) out.push(textNode(cell)); for (const el of direct) { if (el.tagName === "IMG") out.push(imageNode(el as HTMLImageElement)); else if (/^H[1-4]$|^P$/.test(el.tagName)) out.push(text(el) ? textNode(el) : customNode(el)); else if (el.tagName === "A") { if (el.querySelector("img")) out.push(imageNode(el.querySelector("img") as HTMLImageElement)); else if (text(el)) out.push(buttonNode(el as HTMLAnchorElement, cell)); else out.push(customNode(el)); } else if (el.tagName === "TABLE") out.push(...parseTableNode(el as HTMLTableElement)); else if (el.tagName === "HR") out.push({ ...newLeaf("divider", locale), ...nodeStyle(el), height: px(el.getAttribute("size") || "") || 1, sourceHtml: el.outerHTML }); else if (["DIV", "SPAN"].includes(el.tagName)) { const children = Array.from(el.children) as HTMLElement[]; if (children.length) children.forEach(child => { if (child.tagName === "TABLE") out.push(...parseTableNode(child as HTMLTableElement)); else if (child.tagName === "IMG") out.push(imageNode(child as HTMLImageElement)); else if (/^H[1-4]$|^P$/.test(child.tagName)) out.push(text(child) ? textNode(child) : customNode(child)); else if (child.tagName === "A" && text(child)) out.push(buttonNode(child as HTMLAnchorElement, el)); else out.push(customNode(child)); }); else if (text(el)) out.push(textNode(el)); } else if (text(el)) out.push(customNode(el)); }
        if (!out.length && text(cell)) out.push(textNode(cell)); return out; };
    const tables = Array.from(parsed.querySelectorAll("table")), candidates = tables.filter(t => px(readAttr(t, "width") || t.style.width) >= 500), main = (candidates.length ? candidates : tables).sort((a, b) => { const da = Array.from(a.parentElement?.closest("table") ? [a] : []).length, db = Array.from(b.parentElement?.closest("table") ? [b] : []).length; return da - db || text(b).length - text(a).length; })[0], rows: Node[] = [], pre = Array.from(parsed.querySelectorAll("[style*='display:none'],[style*='display: none'],.preheader")).find(x => text(x)); if (pre) rows.push({ id: uid("row"), kind: "row", visible: true, children: [{ ...newColumn(100), padding: 0, children: [{ ...newLeaf("preheader", locale), content: text(pre), sourceHtml: pre.outerHTML }] }] });
    if (main) Array.from(main.rows).forEach(row => { const rowCells = Array.from(row.cells); if (!rowCells.length) return; const widths = distribute(rowCells.map(widthOf), rowCells.length); rows.push({ id: uid("row"), kind: "row", gap: 0, stackMobile: true, visible: true, children: rowCells.map((cell, i) => ({ ...newColumn(widths[i] || 100), ...nodeStyle(cell as HTMLElement), children: parseCell(cell as HTMLTableCellElement), sourceHtml: cell.outerHTML })) }); });
    if (!rows.length) { warnings.push(tr(locale, "Không tìm thấy bảng bố cục chính; phần còn lại được giữ dưới dạng HTML an toàn.", "No main layout table found; remaining content was preserved as safe HTML.")); rows.push({ id: uid("row"), kind: "row", visible: true, children: [{ ...newColumn(100), children: [{ ...customNode(parsed.body) }] }] }); }
    if (dangerous) warnings.push(tr(locale, `${dangerous} thành phần nguy hiểm đã bị loại bỏ.`, `${dangerous} unsafe item(s) were removed.`)); if (dropped.length) warnings.push(tr(locale, `Đã giữ ${preservedBlocks} phần HTML đặc thù và đánh dấu ${dropped.length} phần cần xem lại.`, `${preservedBlocks} special HTML part(s) were preserved and ${dropped.length} item(s) need review.`)); if (unsupportedCss.length) warnings.push(tr(locale, `Một số chỉ thị CSS (${unsupportedCss.join(", ")}) chỉ được giữ trong fallback và không áp vào block native.`, `Some CSS directives (${unsupportedCss.join(", ")}) remain in fallback and are not applied to native blocks.`)); if (allImages.some(img => !readAttr(img, "src").trim())) warnings.push(tr(locale, "Có ảnh không có nguồn; cần chọn lại trong Kho tài nguyên.", "Some images have no source and need rebinding from Assets."));
    const rootStyle = parsed.body ? styleFor(parsed.body) : document.body.style, mainStyle = main ? nodeStyle(main as HTMLElement) : {}, width = px(readAttr(main || parsed.body, "width") || (main as HTMLElement)?.style?.width || "") || defaultTheme.width, theme: EmailTheme = { ...defaultTheme, ...current.theme, width: ([600, 640, 720].includes(width) ? width : 640) as EmailTheme["width"], outerBg: rootStyle.backgroundColor || rootStyle.background || current.theme?.outerBg || defaultTheme.outerBg, contentBg: mainStyle.background || current.theme?.contentBg || defaultTheme.contentBg, fontFamily: rootStyle.fontFamily || current.theme?.fontFamily || defaultTheme.fontFamily };
    const aliases: Record<string, string> = { first_name: "ten_nhan_vien", last_name: "ten_nhan_vien", department: "phong_ban", email: "email_ho_tro" }, mergedVariables = clone(current.variables).filter(v => variablesFound.includes(v.key) || variablesFound.includes(v.key.replace(/^ten_nhan_vien$/, "first_name"))); variablesFound.forEach(key => { if (!mergedVariables.some(v => v.key === key)) { const alias = aliases[key], source = alias && current.variables.find(v => v.key === alias); mergedVariables.push({ key, name: key.replace(/_/g, " "), scope: /email|unsubscribe/i.test(key) ? "system" : /first|last|department|position|manager/i.test(key) ? "recipient" : "template", fallback: source?.fallback || key, required: false, campaignOverride: true }); } });
    const section: Node = { id: uid("section"), kind: "section", name: tr(locale, "Email đã nhập", "Imported email"), background: theme.contentBg, visible: true, children: rows }, all = [section], flat = (ns: Node[]): Node[] => ns.flatMap(n => [n, ...flat(n.children || [])]), nodes = flat(all), sourceText = text(parsed.body), outputText = nodes.map(n => n.content || "").join(" "), sourceLinks = parsed.querySelectorAll("a").length, outputLinks = nodes.filter(n => n.href || n.inline?.some(i => i.type === "link")).length, sourceImages = allImages.length, outputImages = nodes.filter(n => ["image", "banner", "logo"].includes(n.kind)).length, coverage = { text: sourceText ? Math.min(100, Math.round(outputText.length / sourceText.length * 100)) : 100, links: sourceLinks ? Math.min(100, Math.round(outputLinks / sourceLinks * 100)) : 100, images: sourceImages ? Math.min(100, Math.round(outputImages / sourceImages * 100)) : 100, variables: variablesFound.length ? Math.min(100, Math.round(mergedVariables.filter(v => variablesFound.includes(v.key)).length / variablesFound.length * 100)) : 100 };
    return { doc: { title: text(parsed.querySelector("title") || parsed.querySelector("h1") || parsed.body).slice(0, 80) || tr(locale, "Email đã nhập", "Imported email"), variables: mergedVariables, theme, nodes: all }, report: { nativeBlocks: nodes.filter(n => !["section", "row", "column", "custom"].includes(n.kind)).length, customBlocks: nodes.filter(n => n.kind === "custom").length, blocked: dangerous, missingAssets: [...missing], variables: variablesFound, warnings, preservedBlocks, dropped, unsupportedCss, externalAssets: [...externalAssets], coverage } };
}
function ImportSheet({ locale, current, apply, close, expanded, toggleExpanded }: {
    locale: Locale;
    current: Doc;
    apply: (d: Doc) => void;
    close: () => void;
    expanded: boolean;
    toggleExpanded: () => void;
}) {
    const [raw, setRaw] = useState(""), [candidate, setCandidate] = useState<Doc | null>(null), [report, setReport] = useState<ImportReport | null>(null);
    const analyze = (value = raw) => { if (!value.trim()) return; try { const result = parseImportedEmail(value, locale, current); setCandidate(result.doc); setReport(result.report); } catch (error) { console.error("Mailcraft HTML import failed", error); const fallback = newLeaf("custom", locale); fallback.strategy = "preserve"; fallback.fragmentId = fallback.id; try { fallback.html = cleanHtml(value); } catch { fallback.html = value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""); } fallback.css = ""; fallback.sourceHtml = value; const safeMessage = error instanceof Error ? error.message.slice(0, 140) : "unknown parser error"; setCandidate({ title: tr(locale, "Email HTML cần xem lại", "HTML email needs review"), variables: clone(current.variables), theme: { ...defaultTheme, ...current.theme }, nodes: [{ id: uid("section"), kind: "section", name: tr(locale, "HTML được bảo toàn", "Preserved HTML"), background: current.theme?.contentBg || "#ffffff", visible: true, children: [{ id: uid("row"), kind: "row", visible: true, children: [{ ...newColumn(100), children: [fallback] }] }] }] }); setReport({ nativeBlocks: 0, customBlocks: 1, blocked: 0, missingAssets: [], variables: [], warnings: [tr(locale, `Parser không chuyển được file này (${safeMessage}); HTML an toàn đã được giữ nguyên để bạn tiếp tục xử lý.`, `The parser could not convert this file (${safeMessage}); safe HTML was preserved so you can continue.`)], preservedBlocks: 1, dropped: ["parser-error"], unsupportedCss: [], externalAssets: [], coverage: { text: 0, links: 0, images: 0, variables: 0 } }); } };
    return <div className={`v3-sheet-bg sheet-import ${expanded ? "workspace-expanded" : ""}`} onMouseDown={e => e.target === e.currentTarget && close()}><aside className="v3-sheet"><header><span className="v3-sheet-icon">⇥</span><div><b>{tr(locale, "Nhập HTML dạng hybrid", "Hybrid HTML import")}</b><small>{tr(locale, "Nhận diện an toàn, bảo toàn phần chưa hiểu và báo cáo độ phủ", "Recognize safely, preserve unknown parts, and report coverage")}</small></div><button className="v3-workspace-size" title={expanded ? tr(locale, "Thu về kích thước chuẩn", "Use standard width") : tr(locale, "Mở rộng không gian làm việc", "Expand workspace")} onClick={toggleExpanded}>{expanded ? "↘" : "↗"}</button><button onClick={close}>×</button></header><div className="v3-sheet-body v3-import-work"><div className="v3-import-source"><label className="v3-import-file">⇧ <b>{tr(locale, "Chọn file HTML", "Choose HTML file")}</b><small>.html · .htm</small><input type="file" accept=".html,.htm,text/html" onChange={e => { const file = e.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const value = String(reader.result || ""); setRaw(value); analyze(value); }; reader.readAsText(file); }}/></label><span>{tr(locale, "hoặc dán mã nguồn", "or paste source")}</span><textarea value={raw} onChange={e => { setRaw(e.target.value); setCandidate(null); setReport(null); }} placeholder="<!doctype html>..."/><button disabled={!raw.trim()} onClick={() => analyze()}>{tr(locale, "Phân tích cấu trúc", "Analyze structure")}</button></div>{report ? <div className="v3-import-report"><div className={`v3-import-score ${report.dropped.length || report.blocked ? "warn" : ""}`}><span>{report.dropped.length || report.blocked ? "!" : "✓"}</span><div><b>{tr(locale, report.dropped.length || report.blocked ? "Có phần cần xem lại trước khi nhập" : "Sẵn sàng tạo bản nháp chỉnh sửa", report.dropped.length || report.blocked ? "Review required before import" : "Ready to create an editable draft")}</b><small>{tr(locale, `${report.preservedBlocks} phần được bảo toàn · độ phủ chữ ${report.coverage.text}% · link ${report.coverage.links}% · ảnh ${report.coverage.images}%`, `${report.preservedBlocks} fragment(s) preserved · text ${report.coverage.text}% · links ${report.coverage.links}% · images ${report.coverage.images}%`)}</small></div></div><div className="v3-import-metrics"><div><b>{report.nativeBlocks}</b><span>{tr(locale, "Native block", "Native blocks")}</span></div><div><b>{report.customBlocks}</b><span>{tr(locale, "Fallback giữ nguyên", "Preserved fallback")}</span></div><div className={report.blocked ? "warn" : ""}><b>{report.blocked}</b><span>{tr(locale, "Bị chặn", "Blocked")}</span></div><div className={report.missingAssets.length ? "warn" : ""}><b>{report.missingAssets.length}</b><span>{tr(locale, "Ảnh cần liên kết", "Assets to link")}</span></div></div>{report.variables.length > 0 && <section><h3>{tr(locale, "Biến phát hiện", "Variables detected")}</h3>{report.variables.map(key => <code key={key}>{`{{${key}}}`}</code>)}</section>}{report.missingAssets.length > 0 && <section><h3>{tr(locale, "Tài nguyên cần thay thế", "Assets needing replacement")}</h3>{report.missingAssets.slice(0, 8).map(src => <code key={src}>{src}</code>)}</section>}{(report.dropped.length > 0 || report.unsupportedCss.length > 0) && <section className="warn"><h3>{tr(locale, "Phần cần xem lại", "Review required")}</h3>{report.dropped.map(item => <p key={item}>⚠ {item}</p>)}{report.unsupportedCss.map(item => <p key={item}>⚠ CSS {item}</p>)}</section>}{report.warnings.length > 0 && <section className="warn"><h3>{tr(locale, "Cảnh báo import", "Import warnings")}</h3>{report.warnings.map((warning, i) => <p key={i}>⚠ {warning}</p>)}</section>}<div className="v3-import-legend"><span>● {tr(locale, "Native: chỉnh bằng inspector", "Native: editable in the inspector")}</span><span>◆ {tr(locale, "Fallback: giữ HTML an toàn", "Safe HTML preserved")}</span></div></div> : <div className="v3-import-empty"><span>⇥</span><b>{tr(locale, "Nhập một email HTML để bắt đầu", "Add an HTML email to begin")}</b><p>{tr(locale, "Importer nhận diện layout, văn bản, link, ảnh, bảng và giữ phần chưa tương thích dưới dạng fallback an toàn.", "The importer recognizes layout, copy, links, images, tables, and preserves incompatible parts as safe fallback.")}</p></div>}</div><div className="v3-sheet-actionbar"><span>{report ? tr(locale, `${report.nativeBlocks} block chỉnh được · ${report.customBlocks} phần bảo toàn`, `${report.nativeBlocks} editable blocks · ${report.customBlocks} preserved fragments`) : tr(locale, "Phân tích trước khi thay document hiện tại", "Analyze before replacing the current document")}</span><button disabled={!candidate} onClick={() => candidate && apply(candidate)}>{tr(locale, "Nhập thành bản nháp mới", "Import as new draft")}</button></div></aside></div>;
}
function TemplateLibrary({ locale, apply, blank, manage }: {
    locale: Locale;
    apply: (p: TemplatePreset) => void;
    blank: () => void;
    manage: () => void;
}) { const [q, setQ] = useState(""), [filter, setFilter] = useState<"all" | TemplatePreset["category"]>("all"), shown = templatePresets.filter(p => (filter === "all" || p.category === filter) && `${p.vi} ${p.en}`.toLowerCase().includes(q.toLowerCase())); return <div className="v3-template-library"><div className="v3-panel-head"><span><I name="templates"/></span><div><b>{tr(locale, "Kho mẫu", "Template library")}</b><small>{tr(locale, "Bắt đầu nhanh từ một email hoàn chỉnh", "Start quickly from a complete email")}</small></div></div><button className="v3-blank-template" onClick={blank}><span>＋</span><div><b>{tr(locale, "Email trắng", "Blank email")}</b><small>{tr(locale, "Bắt đầu với Section và cột trống hợp lệ", "Start with a valid empty Section and Column")}</small></div><em>→</em></button><label className="v3-search">⌕<input value={q} onChange={e => setQ(e.target.value)} placeholder={tr(locale, "Tìm trong kho mẫu", "Search templates")}/></label><div className="v3-library-filters">{(["all", "hr", "internal", "event"] as const).map(key => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{key === "all" ? tr(locale, "Tất cả", "All") : key === "hr" ? tr(locale, "Nhân sự", "HR") : key === "internal" ? tr(locale, "Nội bộ", "Internal") : tr(locale, "Sự kiện", "Events")}</button>)}</div><div className="v3-template-scroll"><header><b>{tr(locale, "MẪU ĐỀ XUẤT", "RECOMMENDED")}</b><span>{shown.length}</span></header><div className="v3-template-grid">{shown.map(p => <button key={p.id} onClick={() => apply(p)}><span className={`v3-template-thumb ${p.tone}`}><i /><b /><em /><small /></span><span className="v3-template-copy"><b>{tr(locale, p.vi, p.en)}</b><small>{tr(locale, p.descVi, p.descEn)}</small><em>{p.blocks} {tr(locale, "khối", "blocks")}</em></span><strong>{tr(locale, "Dùng mẫu", "Use")}</strong></button>)}</div>{!shown.length && <p className="v3-template-empty">{tr(locale, "Không tìm thấy mẫu phù hợp.", "No matching templates found.")}</p>}</div><footer className="v3-library-footer"><button onClick={manage}><span><b>{tr(locale, "Quản lý toàn bộ kho mẫu", "Manage full template library")}</b><small>{tr(locale, "Mẫu nháp, mẫu đã xuất bản và mẫu dùng chung", "Drafts, published and shared templates")}</small></span><em>→</em></button></footer></div>; }
function Library({ locale, query, setQuery, add }: {
    locale: Locale;
    query: string;
    setQuery: (v: string) => void;
    add: (k: BlockKind) => void;
}) { const groups = [["content", "Nội dung", "Content"], ["media", "Hình ảnh & thương hiệu", "Media & brand"], ["action", "Hành động", "Action"], ["layout", "Khung bố cục", "Layout frames"], ["email", "Chuyên biệt email", "Email essentials"]]; return <><div className="v3-panel-head"><span><I name="insert"/></span><div><b>{tr(locale, "Chèn thành phần", "Insert components")}</b><small>{tr(locale, "Chèn đúng cấp Section, Row hoặc Column đang chọn", "Insert into the selected Section, Row, or Column")}</small></div></div><div className="v3-atomic-note"><span>＋</span><div><b>{tr(locale, "Dựng tự do theo nhu cầu", "Compose for the exact need")}</b><small>{tr(locale, "Section tạo ở layer đầu; layout vào Section/Column; element vào Column.", "Sections are root-level; layouts go into Sections or Columns; elements go into Columns.")}</small></div></div><label className="v3-search">⌕<input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr(locale, "Tìm element hoặc bố cục", "Find elements or layouts")}/></label><div className="v3-block-scroll">{groups.map(g => { const items = blocks.filter(x => x.group === g[0] && tr(locale, x.vi, x.en).toLowerCase().includes(query.toLowerCase())); return items.length ? <section className={g[0] === "layout" ? "layout-section" : ""} key={g[0]}><h3>{tr(locale, g[1], g[2])}<span>{items.length}</span></h3>{items.map(x => <button className={x.kind === "section" || x.kind in layoutSpecs ? "layout-option" : ""} key={x.kind} draggable onDragStart={e => e.dataTransfer.setData("mc/block", x.kind)} onClick={() => add(x.kind)}><i>{x.icon}</i><span><b>{tr(locale, x.vi, x.en)}</b><small>{x.kind === "section" ? tr(locale, "Layer đầu của email", "Email root layer") : x.kind in layoutSpecs ? layoutSpecs[x.kind as LayoutKind].widths.join(" / ") : tr(locale, "Tùy chỉnh ở bảng bên phải", "Configure in the right panel")}</small></span><em>⠿</em></button>)}</section> : null; })}</div></>; }
function ReusableLibrary({ locale, items, insert, rename, remove }: {
    locale: Locale;
    items: SavedBlock[];
    insert: (id: string) => void;
    rename: (id: string) => void;
    remove: (id: string) => void;
}) { const [q, setQ] = useState(""), shown = items.filter(x => x.name.toLowerCase().includes(q.toLowerCase())); return <><div className="v3-panel-head"><span><I name="reusable"/></span><div><b>{tr(locale, "Thư viện khối", "Block library")}</b><small>{tr(locale, "Cấu trúc do người dùng tự dựng và lưu lại", "User-built structures saved for reuse")}</small></div></div><div className="v3-reusable-guide"><span>▣</span><div><b>{tr(locale, "Không có block dựng sẵn", "No opinionated preset blocks")}</b><small>{tr(locale, "Chọn một Row hoặc Column trên canvas, sau đó bấm “Lưu vào Thư viện khối” trong inspector.", "Select a Row or Column on the canvas, then choose “Save to Block library” in the inspector.")}</small></div></div><label className="v3-search">⌕<input value={q} onChange={e => setQ(e.target.value)} placeholder={tr(locale, "Tìm khối đã lưu", "Search saved blocks")}/></label><div className="v3-reusable-scroll">{shown.length ? shown.map(x => { const columns = Math.max(1, Math.min(4, x.node.children?.length || 1)); return <article key={x.id} draggable onDragStart={e => e.dataTransfer.setData("mc/saved", x.id)}><button className="v3-reusable-main" onClick={() => insert(x.id)}><span className="v3-reusable-preview">{Array.from({ length: columns }, (_, i) => <i key={i}/>)}</span><span><b>{x.name}</b><small>{x.elements} {tr(locale, "element · Row/Column có thể chỉnh", "elements · editable Row/Column tree")}</small><em>{tr(locale, "Chèn vào email", "Insert into email")} →</em></span></button><div><button onClick={() => rename(x.id)}>{tr(locale, "Đổi tên", "Rename")}</button><button className="danger" onClick={() => remove(x.id)}>{tr(locale, "Xóa", "Remove")}</button><i>⠿</i></div></article>; }) : <div className="v3-reusable-empty"><span>▣</span><b>{tr(locale, "Chưa có khối nào được lưu", "No saved blocks yet")}</b><p>{tr(locale, "Tự dựng nội dung bằng element và layout, chọn Row hoặc Column, rồi lưu vào đây để sử dụng lại.", "Compose content from elements and layouts, select its Row or Column, then save it here for reuse.")}</p><ol><li>{tr(locale, "Dựng cấu trúc", "Compose")}</li><li>{tr(locale, "Chọn Row/Column", "Select")}</li><li>{tr(locale, "Lưu vào thư viện", "Save")}</li></ol></div>}</div></>; }
function Layers({ locale, nodes, selected, setSelected, patch, addSection }: {
    locale: Locale;
    nodes: Node[];
    selected: string;
    setSelected: (s: string) => void;
    patch: (id: string, p: Partial<Node>) => void;
    addSection: () => void;
}) {
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const branchIds = (items: Node[]): string[] => items.flatMap(n => n.children?.length ? [n.id, ...branchIds(n.children)] : []);
    const toggle = (id: string) => setCollapsed(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
    return <><div className="v3-panel-head"><span><I name="layers"/></span><div><b>{tr(locale, "Cấu trúc email", "Email structure")}</b><small>Section → Row → Column → Element</small></div></div><div className="v3-layer-toolbar"><button onClick={() => setCollapsed(new Set())}>⌄ {tr(locale, "Mở tất cả", "Expand all")}</button><button onClick={() => setCollapsed(new Set(branchIds(nodes)))}>› {tr(locale, "Thu gọn", "Collapse all")}</button><button className="primary" onClick={addSection}>＋ Section</button></div><div className="v3-layer-scroll"><LayerNodes nodes={nodes} depth={0} locale={locale} selected={selected} setSelected={setSelected} patch={patch} collapsed={collapsed} toggle={toggle}/></div></>;
}
function LayerNodes({ nodes, depth, locale, selected, setSelected, patch, collapsed, toggle }: {
    nodes: Node[];
    depth: number;
    locale: Locale;
    selected: string;
    setSelected: (s: string) => void;
    patch: (id: string, p: Partial<Node>) => void;
    collapsed: Set<string>;
    toggle: (id: string) => void;
}) { return <>{nodes.map(n => { const hasChildren = Boolean(n.children?.length), isCollapsed = collapsed.has(n.id); return <div key={n.id}><div className={`v3-layer ${selected === n.id ? "active" : ""}`} style={{ paddingLeft: 7 + depth * 13 }}>{hasChildren ? <button className="v3-layer-toggle" title={isCollapsed ? tr(locale, "Mở nhánh", "Expand branch") : tr(locale, "Thu nhánh", "Collapse branch")} onClick={() => toggle(n.id)}>{isCollapsed ? "›" : "⌄"}</button> : <span className="v3-layer-dot">·</span>}<button className="v3-layer-select" onClick={() => setSelected(n.id)}><b>{nodeName(n, locale)}</b></button><button title={tr(locale, "Ẩn hoặc hiện", "Toggle visibility")} onClick={() => patch(n.id, { visible: n.visible === false })}>{n.visible === false ? "○" : "◉"}</button><button title={tr(locale, "Khóa hoặc mở khóa", "Toggle lock")} onClick={() => patch(n.id, { locked: !n.locked })}>{n.locked ? "◆" : "◇"}</button></div>{hasChildren && !isCollapsed && <LayerNodes nodes={n.children!} depth={depth + 1} locale={locale} selected={selected} setSelected={setSelected} patch={patch} collapsed={collapsed} toggle={toggle}/>}</div>; })}</>; }
function Canvas({ nodes, ...props }: {
    nodes: Node[];
    vars: Variable[];
    locale: Locale;
    device: Device;
    selected: string;
    setSelected: (s: string) => void;
    patch: (id: string, p: Partial<Node>) => void;
    capture: (n: Node, e: HTMLElement) => void;
    drop: (e: React.DragEvent, id: string) => void;
    openAssets: (id: string) => void;
}) { return <>{nodes.map(n => <CanvasNode key={n.id} node={n} nodes={nodes} {...props}/>)}</>; }
function CanvasNode({ node, vars, locale, device, selected, setSelected, patch, capture, drop, openAssets }: {
    node: Node;
    nodes: Node[];
    vars: Variable[];
    locale: Locale;
    device: Device;
    selected: string;
    setSelected: (s: string) => void;
    patch: (id: string, p: Partial<Node>) => void;
    capture: (n: Node, e: HTMLElement) => void;
    drop: (e: React.DragEvent, id: string) => void;
    openAssets: (id: string) => void;
}) {
    if (node.visible === false)
        return null;
    const active = selected === node.id, select = (e: React.MouseEvent) => { e.stopPropagation(); setSelected(node.id); }, kids = node.children && <Canvas nodes={node.children} vars={vars} locale={locale} device={device} selected={selected} setSelected={setSelected} patch={patch} capture={capture} drop={drop} openAssets={openAssets}/>;
    if (node.kind === "section")
        return <section className={`v3-node v3-section ${active ? "active" : ""}`} style={{ background: surfaceBackground(node), border: `${node.borderWidth || 0}px solid ${node.borderColor || "transparent"}`, borderRadius: node.radius, boxShadow: surfaceShadow(node) }} onClick={select} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.stopPropagation(); drop(e, node.id); }}>{active && <Tag n={node} l={locale}/>} {node.children?.length ? kids : <div className="v3-empty-section">＋ {tr(locale, "Thả một bố cục vào Section", "Drop a layout into this Section")}</div>}</section>;
    if (node.kind === "row") {
        const cols = (node.children || []).map(c => `${c.width || Math.round(100 / (node.children?.length || 1))}fr`).join(" ");
        return <div className={`v3-node v3-row ${node.stackMobile && device === "mobile" ? "stack" : ""} ${active ? "active" : ""}`} style={{ gap: node.gap, gridTemplateColumns: node.stackMobile && device === "mobile" ? "1fr" : cols }} onClick={select}>{active && <Tag n={node} l={locale}/>} {kids}</div>;
    }
    if (node.kind === "column")
        return <div className={`v3-node v3-column ${active ? "active" : ""}`} style={{ padding: paddingCss(node), background: surfaceBackground(node), border: `${node.borderWidth || 0}px solid ${node.borderColor || "transparent"}`, borderRadius: node.radius, boxShadow: surfaceShadow(node) }} onClick={select} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.stopPropagation(); drop(e, node.id); }}>{active && <Tag n={node} l={locale}/>} {node.children?.length ? kids : <div className="v3-empty-col">＋ {tr(locale, "Thả thành phần vào đây", "Drop a component here")}</div>}</div>;
    return <div className={`v3-node v3-leaf v3-${node.kind} ${active ? "active" : ""} ${node.locked ? "locked" : ""}`} style={{ paddingTop: node.paddingTop ?? node.padding, paddingRight: node.paddingRight ?? node.padding, paddingBottom: node.paddingBottom ?? node.padding, paddingLeft: node.paddingLeft ?? node.padding, textAlign: node.align }} onClick={select} draggable={!node.locked} onDragStart={e => e.dataTransfer.setData("mc/node", node.id)}>{active && <Tag n={node} l={locale}/>}<Preview n={node} vars={vars} locale={locale} device={device} capture={capture} openAssets={openAssets}/></div>;
}
function Tag({ n, l }: {
    n: Node;
    l: Locale;
}) { return <span className="v3-tag"><I name="drag"/>{nodeName(n, l)}</span>; }
function renderInline(item: InlineNode, vars: Variable[], key: string): React.ReactNode { if (item.type === "text")
    return tokens(item.text || "", vars).map((p, i) => p.key ? <span className="v3-var" title={`{{${p.key}}}`} key={`${key}-${i}`}>{p.text}<i>◇</i></span> : <span key={`${key}-${i}`}>{p.text}</span>); if (item.type === "br")
    return <br key={key}/>; const children = (item.children || []).map((child, i) => renderInline(child, vars, `${key}-${i}`)); if (item.type === "link")
    return <a key={key} href={safeUrl(item.href) || undefined} title={item.title} onClick={e => e.preventDefault()}>{children}</a>; if (item.type === "strong")
    return <strong key={key}>{children}</strong>; if (item.type === "em")
    return <em key={key}>{children}</em>; return <span key={key}>{children}</span>; }
function Rich({ n, vars, cls, capture }: {
    n: Node;
    vars: Variable[];
    cls: string;
    capture: (n: Node, e: HTMLElement) => void;
}) { return <div className={cls} style={{ color: n.textColor, textAlign: n.align, fontSize: n.fontSize, lineHeight: n.lineHeight, fontWeight: n.fontWeight, fontFamily: n.fontFamily, fontStyle: n.italic ? "italic" : "normal", letterSpacing: n.letterSpacing, textTransform: n.textTransform, whiteSpace: "pre-line" }} onMouseUp={e => capture(n, e.currentTarget)}>{n.inline?.length ? n.inline.map((item, i) => renderInline(item, vars, `${n.id}-${i}`)) : tokens(n.content || "", vars).map((p, i) => p.key ? <span className="v3-var" title={`{{${p.key}}}`} key={i}>{p.text}<i>◇</i></span> : <span key={i}>{p.text}</span>)}</div>; }
const platform = (p: Social["platform"]) => ({ facebook: "f", linkedin: "in", instagram: "ig", youtube: "yt", website: "↗" }[p]);
function Preview({ n, vars, locale, device, capture, openAssets }: {
    n: Node;
    vars: Variable[];
    locale: Locale;
    device: Device;
    capture: (n: Node, e: HTMLElement) => void;
    openAssets: (id: string) => void;
}) { if (n.kind === "heading")
    return <Rich n={n} vars={vars} cls="v3-p-heading" capture={capture}/>; if (["text", "contact", "preheader"].includes(n.kind))
    return <Rich n={n} vars={vars} cls={`v3-p-${n.kind}`} capture={capture}/>; if (n.kind === "button")
    return <div className={`v3-p-button width-${n.buttonWidth}`} style={{ textAlign: n.align }}><a href={safeUrl(n.href) || undefined} title={n.linkTitle || undefined} aria-label={n.linkTitle || n.content || undefined} onClick={e => e.preventDefault()} className={`${n.buttonVariant} ${n.buttonSize}`} style={{ background: n.buttonVariant === "solid" ? n.accent : n.buttonVariant === "soft" ? `${n.accent}18` : "transparent", color: n.buttonVariant === "solid" ? n.textColor : n.accent, borderColor: n.accent, borderRadius: n.radius }}>{n.buttonIcon === "left" && "←"}<Rich n={n} vars={vars} cls="v3-button-label" capture={capture}/>{n.buttonIcon === "right" && "→"}</a>{!safeUrl(n.href) && <small>{tr(locale, "Chưa đặt liên kết", "No link set")}</small>}</div>; if (n.kind === "image" || n.kind === "banner") {
    const source = n.kind === "banner" && device === "mobile" && n.mobileSrc ? n.mobileSrc : n.src;
    if (!source)
        return <button className="v3-media-empty" onClick={e => { e.stopPropagation(); openAssets(n.id); }}><span>▧</span><b>{tr(locale, n.kind === "banner" ? "Chọn ảnh banner" : "Chọn hình ảnh", n.kind === "banner" ? "Choose a banner image" : "Choose an image")}</b><small>{tr(locale, "Mở kho tài nguyên", "Open asset library")}</small></button>;
    const image = <img src={source} alt={n.alt || ""} style={{ borderRadius: n.radius, objectFit: n.objectFit }}/>;
    return <div className={`v3-p-image ${n.kind}`} style={{ maxWidth: `${n.maxWidth || 100}%`, marginLeft: n.align === "right" ? "auto" : n.align === "center" ? "auto" : 0, marginRight: n.align === "left" ? 0 : "auto" }}>{safeUrl(n.href) ? <a href={safeUrl(n.href)} onClick={e => e.preventDefault()}>{image}</a> : image}<button onClick={e => { e.stopPropagation(); openAssets(n.id); }}>{tr(locale, "Thay ảnh", "Replace image")}</button>{n.caption && n.kind === "image" && <p>{n.caption}</p>}{!n.alt && <small>⚠ {tr(locale, "Thiếu mô tả ảnh", "Missing alt text")}</small>}</div>;
} if (n.kind === "logo") {
    const logo = n.src ? <img src={n.src} alt={n.alt || n.content || "Logo"} style={{ height: n.height }}/> : <b>{n.content || "ALTA"}</b>;
    return <div className="v3-p-logo" style={{ fontSize: n.height, color: n.accent, textAlign: n.align }}>{safeUrl(n.href) ? <a href={safeUrl(n.href)} onClick={e => e.preventDefault()}>{logo}</a> : logo}<button onClick={e => { e.stopPropagation(); openAssets(n.id); }}>{tr(locale, "Thay logo", "Replace logo")}</button></div>;
} if (n.kind === "social")
    return <div className={`v3-p-social ${n.socialStyle}`} style={{ justifyContent: n.align, gap: 8 }}>{(n.social || []).filter(x => x.enabled).map(x => <a key={x.id} className={!safeUrl(x.url) ? "missing" : ""} href={safeUrl(x.url) || undefined} aria-label={x.label || x.platform} title={x.label || x.platform} onClick={e => e.preventDefault()} style={{ width: n.socialStyle === "text" ? "auto" : n.socialSize, height: n.socialStyle === "text" ? "auto" : n.socialSize, color: n.accent }}>{platform(x.platform)}{!safeUrl(x.url) && <small>!</small>}</a>)}</div>; if (n.kind === "table" && n.table) {
    const t = n.table;
    return <div className="v3-table" style={{ borderRadius: t.radius }}><table>{t.caption && <caption>{t.caption}</caption>}<colgroup>{t.widths.map((w, i) => <col key={i} style={{ width: `${w}%` }}/>)}</colgroup><tbody>{t.cells.map((r, ri) => <tr key={ri}>{r.map((c, ci) => { const cell = t.cellStyles?.[ri]?.[ci] || {}, X = (t.cellTags?.[ri]?.[ci] || (t.header && ri === 0 ? "th" : "td")) as "th" | "td"; return <X key={ci} style={{ padding: paddingCss(cell as Node), textAlign: cell.align || t.align, borderColor: cell.borderColor || t.borderColor, background: cell.background || (t.header && ri === 0 ? t.headerBg : t.zebra && ri % 2 === 0 ? t.altBg : t.rowBg), color: cell.textColor || (t.header && ri === 0 ? t.headerColor : undefined), fontWeight: cell.fontWeight || undefined }}>{tokens(c, vars).map((p, i) => p.key ? <span className="v3-var" key={i}>{p.text}</span> : p.text)}</X>; })}</tr>)}</tbody></table></div>;
} if (n.kind === "divider")
    return <hr style={{ border: 0, borderTop: `${n.height}px solid ${n.accent}` }}/>; if (n.kind === "spacer")
    return <div className="v3-p-spacer" style={{ height: n.height }}><span>{n.height}px</span></div>; if (n.kind === "custom")
    return <div className="v3-custom" data-mc-fragment={n.fragmentId || n.id}><style>{n.css ? cleanCss(n.css) : ""}</style><div dangerouslySetInnerHTML={{ __html: cleanHtml(n.html) }}/><small>✓ {tr(locale, "Đã áp dụng bộ lọc email", "Email safety filter applied")}</small></div>; return null; }
function Inspector({ node, locale, tab, setTab, patch, openAssets, openVars, openHtml, duplicate, remove, saveBlock, addRow, addColumn }: {
    node: Node;
    locale: Locale;
    tab: "content" | "design" | "advanced";
    setTab: (t: "content" | "design" | "advanced") => void;
    patch: (p: Partial<Node>) => void;
    openAssets: () => void;
    openVars: () => void;
    openHtml: () => void;
    duplicate: () => void;
    remove: () => void;
    saveBlock: () => void;
    addRow: () => void;
    addColumn: () => void;
}) {
    const t = node.table || defaultTable(), setTable = (p: Partial<Table>) => patch({ table: { ...t, ...p } }), resize = (rows: number, cols: number) => setTable({ rows, cols, cells: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => t.cells[r]?.[c] || (r === 0 ? tr(locale, "Tiêu đề", "Heading") : tr(locale, "Nội dung", "Content")))), widths: Array.from({ length: cols }, () => Math.round(100 / cols)) }), social = (id: string, p: Partial<Social>) => patch({ social: (node.social || []).map(x => x.id === id ? { ...x, ...p } : x) }), setContact = (p: Partial<ContactData>) => { const contact = { name: "", role: "", email: "", phone: "", address: "", ...node.contact, ...p }; patch({ contact, content: [[contact.name, contact.role].filter(Boolean).join(" · "), [contact.email, contact.phone].filter(Boolean).join(" · "), contact.address].filter(Boolean).join("\n") }); };
    return <aside className="v3-inspector"><div className="v3-inspect-head"><span>{node.kind === "table" ? "▤" : node.kind === "button" ? "↗" : node.kind === "logo" ? "A" : "◦"}</span><div><b>{nodeName(node, locale)}</b><small>{responsibility(node, locale)}</small></div><button title={tr(locale, "Nhân bản nhanh", "Quick duplicate")} aria-label={tr(locale, "Nhân bản nhanh", "Quick duplicate")} onClick={duplicate}>▣</button></div><div className="v3-tabs">{(["content", "design", "advanced"] as const).map(x => <button key={x} className={tab === x ? "active" : ""} onClick={() => setTab(x)}>{x === "content" ? tr(locale, "Nội dung", "Content") : x === "design" ? tr(locale, "Thiết kế", "Design") : tr(locale, "Nâng cao", "Advanced")}</button>)}</div><div className="v3-inspect-scroll">
 {tab === "content" && <>{node.kind === "section" && <Group title={tr(locale, "Cấu trúc Section", "Section structure")}><p>{tr(locale, "Section chỉ chứa hàng để HTML email ổn định.", "Sections only contain rows for stable HTML.")}</p><button className="wide" onClick={addRow}>＋ {tr(locale, "Thêm hàng 2 cột", "Add 2-column row")}</button></Group>}{node.kind === "row" && <Group title={tr(locale, "Tỷ lệ bố cục", "Layout ratio")}><p>{tr(locale, "Đổi tỷ lệ mà không làm mất nội dung đang có trong các cột.", "Change the ratio without losing content in existing columns.")}</p><div className="v3-row-layouts">{Object.entries(layoutSpecs).filter(([, spec]) => spec.widths.length === (node.children || []).length).map(([key, spec]) => <button key={key} className={(node.children || []).every((c, i) => (c.width || 0) === spec.widths[i]) ? "active" : ""} onClick={() => patch({ children: (node.children || []).map((c, i) => ({ ...c, width: spec.widths[i] })) })}><i>{spec.widths.map((w, i) => <span key={i} style={{ flex: w }}/>)}</i><b>{tr(locale, spec.vi, spec.en)}</b><small>{spec.widths.join(" / ")}</small></button>)}</div><button className="wide" onClick={addColumn}>＋ {tr(locale, "Thêm một cột", "Add another column")}</button><Toggle checked={node.stackMobile !== false} onChange={v => patch({ stackMobile: v })} label={tr(locale, "Xếp dọc trên mobile", "Stack on mobile")}/></Group>}{node.kind === "column" && <Group title={tr(locale, "Bố cục lồng", "Nested layout")}><button className="wide" onClick={addRow}>＋ {tr(locale, "Thêm layout 2 cột bên trong", "Add nested 2-column layout")}</button></Group>}{["row", "column"].includes(node.kind) && <Group title={tr(locale, "Tái sử dụng cấu trúc", "Reuse structure")}><p>{tr(locale, "Lưu cây Row/Column hiện tại vào thư viện riêng. Đây là snapshot tái sử dụng, không phải một loại element mới.", "Save the current Row/Column tree to a separate library. It is a reusable snapshot, not a new element type.")}</p><button className="wide v3-save-reusable" onClick={saveBlock}>▣ {tr(locale, "Lưu vào Thư viện khối", "Save to Block library")}</button></Group>}{node.kind === "text" && <Group title={tr(locale, "Nội dung đoạn văn", "Paragraph content")}><Field label={tr(locale, "Văn bản", "Text")} hint={`${(node.content || "").length} ${tr(locale, "ký tự", "characters")}`}><textarea value={node.content || ""} onChange={e => patch({ content: e.target.value })}/></Field><button className="wide" onClick={openVars}>◇ {tr(locale, "Chèn biến tại cuối nội dung", "Insert data variable")}</button></Group>}{node.kind === "heading" && <Group title={tr(locale, "Nội dung tiêu đề", "Heading content")}><Field label={tr(locale, "Cấp tiêu đề", "Heading level")}><Segment values={["H1", "H2", "H3", "H4"]} value={`H${node.headingLevel || 2}`} set={v => patch({ headingLevel: Number(v.slice(1)) as 1 | 2 | 3 | 4 })}/></Field><Field label={tr(locale, "Tiêu đề", "Heading")} hint={`${(node.content || "").length} ${tr(locale, "ký tự", "characters")}`}><textarea value={node.content || ""} onChange={e => patch({ content: e.target.value })}/></Field><button className="wide" onClick={openVars}>◇ {tr(locale, "Chèn biến dữ liệu", "Insert data variable")}</button></Group>}{node.kind === "button" && <Group title={tr(locale, "Nhãn hành động", "Action label")}><Field label={tr(locale, "Nhãn nút", "Button label")}><input value={node.content || ""} onChange={e => patch({ content: e.target.value })}/></Field><button className="wide" onClick={openVars}>◇ {tr(locale, "Chèn biến dữ liệu", "Insert data variable")}</button></Group>}{node.kind === "contact" && <Group title={tr(locale, "Thông tin liên hệ", "Contact details")}><Field label={tr(locale, "Tên hoặc bộ phận", "Name or team")}><input value={node.contact?.name || ""} onChange={e => setContact({ name: e.target.value })}/></Field><Field label={tr(locale, "Vai trò hoặc công ty", "Role or company")}><input value={node.contact?.role || ""} onChange={e => setContact({ role: e.target.value })}/></Field><Field label="Email"><input value={node.contact?.email || ""} onChange={e => setContact({ email: e.target.value })}/></Field><Field label={tr(locale, "Điện thoại", "Phone")}><input value={node.contact?.phone || ""} onChange={e => setContact({ phone: e.target.value })}/></Field><Field label={tr(locale, "Địa chỉ", "Address")} hint={tr(locale, "Có thể nhập trực tiếp biến dạng {{ten_bien}} vào từng trường.", "You can type {{variable_key}} directly into any field.")}><textarea value={node.contact?.address || ""} onChange={e => setContact({ address: e.target.value })}/></Field></Group>}{node.kind === "preheader" && <Group title={tr(locale, "Dòng xem trước hộp thư", "Inbox preview text")}><Field label="Preheader" hint={`${(node.content || "").length}/110 ${tr(locale, "ký tự khuyến nghị", "recommended characters")}`}><textarea maxLength={160} value={node.content || ""} onChange={e => patch({ content: e.target.value })}/></Field><div className={`v3-length ${((node.content || "").length > 110) ? "warn" : ""}`}><i style={{ width: `${Math.min(100, (node.content || "").length / 110 * 100)}%` }}/></div><button className="wide" onClick={openVars}>◇ {tr(locale, "Chèn biến dữ liệu", "Insert data variable")}</button></Group>}{node.kind === "button" && <Group title={tr(locale, "Đích đến", "Destination")}><Field label={tr(locale, "Liên kết", "Link")} hint={tr(locale, "Hỗ trợ HTTPS, mailto và tel. Không dùng liên kết #.", "Supports HTTPS, mailto and tel. Never use #.")}><input value={node.href || ""} placeholder="https://" onChange={e => patch({ href: e.target.value })}/></Field><Field label={tr(locale, "Mô tả liên kết", "Link title")} hint={tr(locale, "Giúp người dùng trình đọc màn hình hiểu hành động.", "Clarifies the action for screen readers.")}><input value={node.linkTitle || ""} onChange={e => patch({ linkTitle: e.target.value })}/></Field><Field label={tr(locale, "Biểu tượng", "Icon")}><Segment values={["none", "left", "right"]} value={node.buttonIcon || "none"} set={v => patch({ buttonIcon: v as Node["buttonIcon"] })}/></Field></Group>}{node.kind === "image" && <Group title={tr(locale, "Nội dung hình ảnh", "Image content")}><button className="asset" onClick={openAssets}><span>▧</span><div><b>{node.assetId ? tr(locale, "Thay tài nguyên", "Replace asset") : tr(locale, "Chọn từ thư viện", "Choose from library")}</b><small>{node.assetId || tr(locale, "Kho ảnh và bộ nhận diện", "Images and brand kit")}</small></div></button><Field label={tr(locale, "Mô tả ảnh (alt)", "Image description (alt)")} hint={tr(locale, "Mô tả nội dung và mục đích của ảnh.", "Describe the image content and purpose.")}><textarea value={node.alt || ""} onChange={e => patch({ alt: e.target.value })}/></Field><Field label={tr(locale, "Chú thích ảnh", "Caption")}><input value={node.caption || ""} onChange={e => patch({ caption: e.target.value })}/></Field><Field label={tr(locale, "Liên kết khi bấm ảnh", "Image link")}><input value={node.href || ""} placeholder="https://" onChange={e => patch({ href: e.target.value })}/></Field></Group>}{node.kind === "banner" && <Group title={tr(locale, "Nội dung banner", "Banner content")}><button className="asset" onClick={openAssets}><span>▧</span><div><b>{node.assetId ? tr(locale, "Thay tài nguyên", "Replace asset") : tr(locale, "Chọn từ thư viện", "Choose from library")}</b><small>{node.assetId || tr(locale, "Kho ảnh và bộ nhận diện", "Images and brand kit")}</small></div></button><Field label={tr(locale, "Mô tả thông điệp (alt)", "Message description (alt)")}><textarea value={node.alt || ""} onChange={e => patch({ alt: e.target.value })}/></Field><Field label={tr(locale, "Liên kết toàn banner", "Full-banner link")}><input value={node.href || ""} placeholder="https://" onChange={e => patch({ href: e.target.value })}/></Field><Field label={tr(locale, "Ảnh mobile riêng", "Mobile image URL")} hint={tr(locale, "Để trống để dùng cùng ảnh desktop.", "Leave empty to reuse the desktop image.")}><input value={node.mobileSrc || ""} placeholder="https://" onChange={e => patch({ mobileSrc: e.target.value })}/></Field></Group>}{node.kind === "logo" && <Group title={tr(locale, "Nhận diện thương hiệu", "Brand identity")}><button className="asset" onClick={openAssets}><span>▧</span><div><b>{node.assetId ? tr(locale, "Thay tài nguyên", "Replace asset") : tr(locale, "Chọn từ thư viện", "Choose from library")}</b><small>{node.assetId || tr(locale, "Kho ảnh và bộ nhận diện", "Images and brand kit")}</small></div></button><Field label={tr(locale, "Tên thay thế logo", "Logo alt text")}><input value={node.alt || ""} onChange={e => patch({ alt: e.target.value })}/></Field><Field label={tr(locale, "Website thương hiệu", "Brand website")}><input value={node.href || ""} placeholder="https://" onChange={e => patch({ href: e.target.value })}/></Field></Group>}{node.kind === "social" && <Group title={tr(locale, "Kênh mạng xã hội", "Social channels")}><p>{tr(locale, "Mỗi kênh cần URL thật và nhãn truy cập rõ ràng.", "Every channel needs a real URL and accessible label.")}</p><div className="v3-social-edit">{(node.social || []).map(x => <div className="v3-social-row" key={x.id}><button className={x.enabled ? "on" : ""} onClick={() => social(x.id, { enabled: !x.enabled })}>{platform(x.platform)}</button><select value={x.platform} onChange={e => social(x.id, { platform: e.target.value as Social["platform"] })}>{["facebook", "linkedin", "instagram", "youtube", "website"].map(v => <option key={v}>{v}</option>)}</select><span><input value={x.url} placeholder="https://" onChange={e => social(x.id, { url: e.target.value })}/><input value={x.label || ""} placeholder={tr(locale, "Nhãn truy cập", "Accessible label")} onChange={e => social(x.id, { label: e.target.value })}/></span><button onClick={() => patch({ social: (node.social || []).filter(s => s.id !== x.id) })}>×</button></div>)}</div><button className="wide" onClick={() => patch({ social: [...(node.social || []), { id: uid("soc"), platform: "website", url: "", label: tr(locale, "Website công ty", "Company website"), enabled: true }] })}>＋ {tr(locale, "Thêm kênh", "Add channel")}</button></Group>}{node.kind === "table" && <><Group title={tr(locale, "Cấu trúc bảng", "Table structure")}><Field label={tr(locale, "Tên hoặc mô tả bảng", "Table caption")} hint={tr(locale, "Giúp người đọc hiểu bảng trước khi đi vào dữ liệu.", "Helps readers understand the data before scanning cells.")}><input value={t.caption || ""} onChange={e => setTable({ caption: e.target.value })}/></Field><div className="pair"><Field label={tr(locale, "Hàng", "Rows")}><input type="number" min="2" max="10" value={t.rows} onChange={e => resize(+e.target.value, t.cols)}/></Field><Field label={tr(locale, "Cột", "Columns")}><input type="number" min="2" max="6" value={t.cols} onChange={e => resize(t.rows, +e.target.value)}/></Field></div><Toggle checked={t.header} onChange={v => setTable({ header: v })} label={tr(locale, "Dòng đầu là header", "First row is a header")}/><Toggle checked={t.zebra} onChange={v => setTable({ zebra: v })} label={tr(locale, "Tô nền xen kẽ", "Alternating row fill")}/></Group><Group title={tr(locale, "Nội dung ô", "Cell content")}><div className="v3-cells" style={{ gridTemplateColumns: `repeat(${t.cols},minmax(82px,1fr))` }}>{t.cells.flatMap((r, ri) => r.map((c, ci) => <input key={`${ri}-${ci}`} value={c} onChange={e => { const cells = t.cells.map(x => [...x]); cells[ri][ci] = e.target.value; setTable({ cells }); }}/>))}</div></Group></>}{node.kind === "divider" && <Group title={tr(locale, "Block phân tách", "Separator block")}><p>{tr(locale, "Divider không có nội dung văn bản. Độ dày, màu và khoảng cách nằm trong tab Thiết kế.", "A divider has no text content. Thickness, color and spacing belong in Design.")}</p><button className="wide" onClick={() => setTab("design")}>{tr(locale, "Mở phần Thiết kế", "Open Design settings")} →</button></Group>}{node.kind === "spacer" && <Group title={tr(locale, "Block khoảng cách", "Spacing block")}><p>{tr(locale, "Spacer chỉ tạo khoảng thở dọc và không xuất nội dung đọc được.", "A spacer only creates vertical rhythm and exports no readable content.")}</p><button className="wide" onClick={() => setTab("design")}>{tr(locale, "Điều chỉnh chiều cao", "Adjust height")} →</button></Group>}{node.kind === "custom" && <Group title={tr(locale, "Mã tùy chỉnh", "Custom code")}><button className="code" onClick={openHtml}><span>&lt;/&gt;</span><div><b>{tr(locale, "Mở trình sửa HTML/CSS", "Open HTML/CSS editor")}</b><small>{tr(locale, "Có kiểm tra an toàn và preview", "Safety checks and live preview")}</small></div></button></Group>}</>}
 {tab === "design" && <>{["section", "column"].includes(node.kind) && <Group title={tr(locale, "Nền & khoảng cách", "Surface & spacing")}><Field label={tr(locale, "Màu nền", "Background")}><Color value={node.background || "#ffffff"} set={v => patch({ background: v })}/></Field><Field label={`${tr(locale, "Khoảng đệm", "Padding")} · ${node.padding || 0}px`}><input type="range" min="0" max="72" value={node.padding || 0} onChange={e => patch({ padding: +e.target.value })}/></Field></Group>}{node.kind === "row" && <Group title={tr(locale, "Nhịp bố cục", "Layout rhythm")}><Field label={`${tr(locale, "Khoảng cột", "Column gap")} · ${node.gap || 0}px`}><input type="range" min="0" max="32" value={node.gap || 0} onChange={e => patch({ gap: +e.target.value })}/></Field></Group>}{["text", "heading", "contact"].includes(node.kind) && <Group title={tr(locale, "Chữ", "Typography")}><Field label={`${tr(locale, "Cỡ chữ", "Font size")} · ${node.fontSize || 14}px`}><input type="range" min="10" max={node.kind === "heading" ? 56 : 24} value={node.fontSize || 14} onChange={e => patch({ fontSize: +e.target.value })}/></Field><Field label={`${tr(locale, "Chiều cao dòng", "Line height")} · ${node.lineHeight || 1.6}`}><input type="range" min="1" max="2" step=".05" value={node.lineHeight || 1.6} onChange={e => patch({ lineHeight: +e.target.value })}/></Field>{node.kind !== "contact" && <Field label={tr(locale, "Độ đậm", "Font weight")}><Segment values={["400", "500", "600", "700"]} value={String(node.fontWeight || 400)} set={v => patch({ fontWeight: +v })}/></Field>}<Color value={node.textColor || "#30463d"} set={v => patch({ textColor: v })}/><Align value={node.align || "left"} set={v => patch({ align: v })}/></Group>}{node.kind === "preheader" && <Group title={tr(locale, "Hiển thị kỹ thuật", "Technical display")}><p>{tr(locale, "Preheader được ẩn trong thân email và chỉ dùng cho dòng xem trước của hộp thư.", "The preheader is hidden in the email body and used only for inbox preview text.")}</p></Group>}{node.kind === "button" && <><Group title={tr(locale, "Kiểu nút", "Button style")}><div className="v3-presets">{(["solid", "outline", "soft", "link"] as const).map(v => <button className={node.buttonVariant === v ? "active" : ""} onClick={() => patch({ buttonVariant: v })} key={v}><i className={v}/>{v}</button>)}</div><Field label={tr(locale, "Hình dạng", "Shape")}><div className="v3-shapes">{[0, 6, 12, 999].map(v => <button className={node.radius === v ? "active" : ""} onClick={() => patch({ radius: v })} key={v}><i style={{ borderRadius: v }}/><span>{v === 999 ? tr(locale, "Viên thuốc", "Pill") : v === 0 ? tr(locale, "Vuông", "Square") : `${v}px`}</span></button>)}</div></Field><Field label={tr(locale, "Kích thước", "Size")}><Segment values={["sm", "md", "lg"]} value={node.buttonSize || "md"} set={v => patch({ buttonSize: v as Node["buttonSize"] })}/></Field><Toggle checked={node.buttonWidth === "full"} onChange={v => patch({ buttonWidth: v ? "full" : "auto" })} label={tr(locale, "Chiếm toàn bộ chiều rộng", "Full-width button")}/><Align value={node.align || "left"} set={v => patch({ align: v })}/></Group><Group title={tr(locale, "Màu sắc", "Colors")}><Color value={node.accent || "#173f33"} set={v => patch({ accent: v })}/><Color value={node.textColor || "#ffffff"} set={v => patch({ textColor: v })}/></Group></>}{["image", "banner"].includes(node.kind) && <Group title={node.kind === "banner" ? tr(locale, "Khung banner", "Banner frame") : tr(locale, "Khung hình ảnh", "Image frame")}><Field label={`${tr(locale, "Chiều rộng tối đa", "Maximum width")} · ${node.maxWidth || 100}%`}><input type="range" min="20" max="100" value={node.maxWidth || 100} onChange={e => patch({ maxWidth: +e.target.value })}/></Field><Field label={tr(locale, "Cách đặt ảnh", "Image fit")}><Segment values={["contain", "cover"]} value={node.objectFit || "contain"} set={v => patch({ objectFit: v as Node["objectFit"] })}/></Field><Field label={`${tr(locale, "Bo góc", "Corner radius")} · ${node.radius || 0}px`}><input type="range" min="0" max="32" value={node.radius || 0} onChange={e => patch({ radius: +e.target.value })}/></Field><Align value={node.align || "center"} set={v => patch({ align: v })}/></Group>}{node.kind === "divider" && <Group title={tr(locale, "Đường phân tách", "Divider style")}><Field label={`${tr(locale, "Độ dày", "Thickness")} · ${node.height || 1}px`}><input type="range" min="1" max="8" value={node.height || 1} onChange={e => patch({ height: +e.target.value })}/></Field><Field label={`${tr(locale, "Khoảng cách", "Spacing")} · ${node.padding || 0}px`}><input type="range" min="0" max="48" value={node.padding || 0} onChange={e => patch({ padding: +e.target.value })}/></Field><Color value={node.accent || "#dbe5e0"} set={v => patch({ accent: v })}/></Group>}{node.kind === "spacer" && <Group title={tr(locale, "Khoảng thở", "Vertical spacing")}><Field label={`${tr(locale, "Chiều cao", "Height")} · ${node.height || 32}px`}><input type="range" min="4" max="120" value={node.height || 32} onChange={e => patch({ height: +e.target.value })}/></Field></Group>}{node.kind === "social" && <Group title={tr(locale, "Hình thức hiển thị", "Appearance")}><Segment values={["circle", "square", "text"]} value={node.socialStyle || "circle"} set={v => patch({ socialStyle: v as Node["socialStyle"] })}/><Field label={`${tr(locale, "Kích thước", "Size")} · ${node.socialSize}px`}><input type="range" min="24" max="48" value={node.socialSize || 32} onChange={e => patch({ socialSize: +e.target.value })}/></Field><Color value={node.accent || "#173f33"} set={v => patch({ accent: v })}/><Align value={node.align || "center"} set={v => patch({ align: v })}/></Group>}{node.kind === "table" && <Group title={tr(locale, "Giao diện bảng", "Table appearance")}><Field label={tr(locale, "Nền header", "Header background")}><Color value={t.headerBg} set={v => setTable({ headerBg: v })}/></Field><Field label={tr(locale, "Chữ header", "Header text")}><Color value={t.headerColor} set={v => setTable({ headerColor: v })}/></Field><div className="pair"><Color value={t.rowBg} set={v => setTable({ rowBg: v })}/><Color value={t.altBg} set={v => setTable({ altBg: v })}/></div><Field label={tr(locale, "Đường viền", "Border")}><Color value={t.borderColor} set={v => setTable({ borderColor: v })}/></Field><Field label={`${tr(locale, "Khoảng đệm ô", "Cell padding")} · ${t.cellPadding}px`}><input type="range" min="4" max="24" value={t.cellPadding} onChange={e => setTable({ cellPadding: +e.target.value })}/></Field><Align value={t.align} set={v => setTable({ align: v })}/><Field label={tr(locale, "Tỉ lệ cột (%)", "Column widths (%)")}><div className="v3-widths">{t.widths.map((w, i) => <input key={i} type="number" value={w} onChange={e => { const widths = [...t.widths]; widths[i] = +e.target.value; setTable({ widths }); }}/>)}</div></Field></Group>}{node.kind === "logo" && <Group title={tr(locale, "Kích thước logo", "Logo sizing")}><Field label={`${tr(locale, "Chiều cao", "Height")} · ${node.height || 36}px`}><input type="range" min="20" max="72" value={node.height || 36} onChange={e => patch({ height: +e.target.value })}/></Field><Color value={node.accent || "#173f33"} set={v => patch({ accent: v })}/><Align value={node.align || "center"} set={v => patch({ align: v })}/></Group>}</>}
 {tab === "design" && ["text", "heading", "contact"].includes(node.kind) && <TypographyExtras node={node} locale={locale} patch={patch}/>}
 {tab === "design" && ["section", "column"].includes(node.kind) && <SurfaceExtras node={node} locale={locale} patch={patch}/>}
 {tab === "advanced" && <><Group title={tr(locale, "Nhận diện trong editor", "Editor identity")}><Field label={tr(locale, "Tên trong Layers", "Layers name")}><input value={node.name || ""} placeholder={nodeName({ ...node, name: undefined }, locale)} onChange={e => patch({ name: e.target.value })}/></Field><Field label="Component ID"><input readOnly value={node.id}/></Field></Group><Group title={tr(locale, "Trạng thái thành phần", "Component state")}><Toggle checked={node.visible !== false} onChange={v => patch({ visible: v })} label={tr(locale, "Hiển thị trong email", "Visible in email")}/><Toggle checked={Boolean(node.locked)} onChange={v => patch({ locked: v })} label={tr(locale, "Khóa chỉnh sửa và kéo thả", "Lock editing and dragging")}/></Group></>}
 </div><div className="v3-inspect-actions"><button onClick={duplicate}>▣ {tr(locale, "Nhân bản", "Duplicate")}</button><button className="danger" disabled={node.kind === "section"} onClick={remove}>⌫ {tr(locale, "Xóa", "Delete")}</button></div></aside>;
}
function TypographyExtras({ node, locale, patch }: {
    node: Node;
    locale: Locale;
    patch: (p: Partial<Node>) => void;
}) { return <Group title={tr(locale, "Kiểu chữ nâng cao", "Advanced typography")}><Field label={tr(locale, "Họ phông chữ", "Font family")}><select value={node.fontFamily || "inherit"} onChange={e => patch({ fontFamily: e.target.value })}><option value="inherit">{tr(locale, "Theo chủ đề email", "Use email theme")}</option><option value="Arial, Helvetica, sans-serif">Arial</option><option value="Georgia, 'Times New Roman', serif">Georgia</option><option value="Tahoma, Arial, sans-serif">Tahoma</option><option value="'Courier New', monospace">Courier New</option></select></Field><Field label={`${tr(locale, "Giãn ký tự", "Letter spacing")} · ${node.letterSpacing || 0}px`}><input type="range" min="-1" max="5" step=".1" value={node.letterSpacing || 0} onChange={e => patch({ letterSpacing: +e.target.value })}/></Field><Toggle checked={Boolean(node.italic)} onChange={v => patch({ italic: v })} label={tr(locale, "Chữ nghiêng", "Italic")}/><Field label={tr(locale, "Biến đổi chữ", "Text transform")}><Segment values={["none", "uppercase", "lowercase"]} value={node.textTransform || "none"} set={v => patch({ textTransform: v as Node["textTransform"] })}/></Field></Group>; }
function SurfaceExtras({ node, locale, patch }: {
    node: Node;
    locale: Locale;
    patch: (p: Partial<Node>) => void;
}) { const elevation = node.elevation || "flat"; return <Group title={tr(locale, "Bề mặt nâng cao", "Advanced surface")}><Field label={tr(locale, "Kiểu nền", "Background type")}><Segment values={["solid", "gradient"]} value={node.backgroundMode || "solid"} set={v => patch({ backgroundMode: v as Node["backgroundMode"] })}/></Field>{node.backgroundMode === "gradient" && <><Field label={tr(locale, "Màu kết thúc gradient", "Gradient end color")}><Color value={node.gradientTo || "#e9f3ee"} set={v => patch({ gradientTo: v })}/></Field><Field label={`${tr(locale, "Góc chuyển màu", "Gradient angle")} · ${node.gradientAngle || 135}°`}><input type="range" min="0" max="360" step="15" value={node.gradientAngle || 135} onChange={e => patch({ gradientAngle: +e.target.value })}/></Field></>}<Field label={tr(locale, "Chiều sâu bề mặt", "Surface depth")}><div className="v3-surface-presets">{(["flat", "soft", "strong", "inset"] as const).map(v => <button key={v} className={elevation === v ? "active" : ""} onClick={() => patch({ elevation: v })}><i className={v}/><span>{v === "flat" ? tr(locale, "Phẳng", "Flat") : v === "soft" ? tr(locale, "Nổi nhẹ", "Soft") : v === "strong" ? tr(locale, "Nổi rõ", "Raised") : tr(locale, "Lõm", "Inset")}</span></button>)}</div></Field>{elevation !== "flat" && <Field label={tr(locale, "Màu bóng", "Shadow color")}><Color value={node.shadowColor || "#b8c7c0"} set={v => patch({ shadowColor: v })}/></Field>}<Field label={`${tr(locale, "Độ dày viền", "Border width")} · ${node.borderWidth || 0}px`}><input type="range" min="0" max="8" value={node.borderWidth || 0} onChange={e => patch({ borderWidth: +e.target.value })}/></Field><Field label={tr(locale, "Màu viền", "Border color")}><Color value={node.borderColor || "#dce4e0"} set={v => patch({ borderColor: v })}/></Field><Field label={`${tr(locale, "Bo góc", "Corner radius")} · ${node.radius || 0}px`}><input type="range" min="0" max="32" value={node.radius || 0} onChange={e => patch({ radius: +e.target.value })}/></Field><p className="v3-email-fallback">{tr(locale, "Email-safe: luôn xuất màu nền phẳng và viền làm fallback. Gradient và bóng được dùng ở Gmail/Apple Mail; Outlook desktop có thể bỏ qua hiệu ứng nhưng nội dung vẫn nguyên vẹn.", "Email-safe: a solid background and border are always exported as fallbacks. Gmail and Apple Mail use gradients and shadows; desktop Outlook may ignore the effects while preserving the content.")}</p></Group>; }
function Group({ title, children }: {
    title: string;
    children: React.ReactNode;
}) { return <section className="v3-group"><h3>{title}</h3>{children}</section>; }
function Color({ value, set }: {
    value: string;
    set: (s: string) => void;
}) { return <div className="v3-color"><input type="color" value={value} onChange={e => set(e.target.value)}/><input value={value} onChange={e => set(e.target.value)}/></div>; }
function Segment({ values, value, set }: {
    values: string[];
    value: string;
    set: (v: string) => void;
}) { return <div className="v3-segment">{values.map(v => <button className={value === v ? "active" : ""} onClick={() => set(v)} key={v}>{v}</button>)}</div>; }
function Align({ value, set }: {
    value: Align;
    set: (v: Align) => void;
}) { return <div className="v3-segment">{(["left", "center", "right"] as const).map(v => <button className={value === v ? "active" : ""} onClick={() => set(v)} key={v}>{v === "left" ? "≡←" : v === "center" ? "≡" : "→≡"}</button>)}</div>; }
function Sheet({ type, locale, close, expanded, toggleExpanded, createBlank, doc, issues, html, assets, assetTarget, pickAsset, selectIssue, insertVar, applyTemplate, notify, active, patchActive }: {
    type: Exclude<Panel, null>;
    locale: Locale;
    close: () => void;
    expanded: boolean;
    toggleExpanded: () => void;
    createBlank: () => void;
    doc: Doc;
    issues: ReturnType<typeof review>;
    html: string;
    assets: Asset[];
    assetTarget: AssetTarget | null;
    pickAsset: (a: Asset) => void;
    selectIssue: (id?: string) => void;
    insertVar: (v: Variable) => void;
    applyTemplate: (p: TemplatePreset) => void;
    notify: (s: string) => void;
    active?: Node;
    patchActive: (p: Partial<Node>) => void;
}) {
    const [q, setQ] = useState(""), [recipient, setRecipient] = useState(0), [variableScope, setVariableScope] = useState<"all" | Variable["scope"]>("all"), [assetFilter, setAssetFilter] = useState<"all" | "image" | "logo">(() => assetTarget?.accept === "image" ? "image" : assetTarget?.accept === "logo" ? "logo" : "all"), [reviewFilter, setReviewFilter] = useState<"all" | "error" | "warn">("all"), [selectedVersion, setSelectedVersion] = useState(1), titles: Record<Exclude<Panel, null>, [
        string,
        string
    ]> = { templates: ["Kho mẫu Mailcraft", "Mailcraft template library"], variables: ["Biến dữ liệu", "Data variables"], assets: ["Kho tài nguyên & logo", "Assets & logo library"], review: ["Soát nội dung", "Content review"], preview: ["Xem trước bằng người nhận thật", "Preview with real recipients"], history: ["Lịch sử phiên bản", "Version history"], publish: ["Xuất bản resource", "Publish resource"], html: ["HTML/CSS tùy chỉnh", "Custom HTML/CSS"] }, icons: Record<Exclude<Panel, null>, string> = { templates: "▦", variables: "◇", assets: "▧", review: "✓", preview: "◉", history: "↶", publish: "↑", html: "</>" }, people = [{ name: "Nguyễn Thu Hà", dept: "Nhân sự" }, { name: "Trần Minh Đức", dept: "Marketing" }, { name: "Lê An", dept: "—" }], targetNode = assetTarget?.nodeId ? find(doc.nodes, assetTarget.nodeId) : undefined;
    return <div className={`v3-sheet-bg sheet-${type} ${expanded ? "workspace-expanded" : ""}`} onMouseDown={e => e.target === e.currentTarget && close()}><aside className="v3-sheet"><header><span className="v3-sheet-icon">{icons[type]}</span><div><b>{tr(locale, ...titles[type])}</b><small>{type === "templates" ? tr(locale, "Chọn bằng hình ảnh, áp dụng vào cùng document hiện tại", "Choose visually and apply to the current document") : type === "variables" ? tr(locale, "Tra cứu, kiểm dữ liệu và chèn không cần nhớ cú pháp", "Search, validate and insert without memorizing syntax") : type === "assets" ? assetTarget?.mode === "replace" ? tr(locale, `Chọn ${assetTarget.accept === "logo" ? "logo" : "hình ảnh"} để thay cho ${targetNode ? nodeName(targetNode, locale) : "khối hiện tại"}`, `Choose a ${assetTarget.accept} to replace the current component`) : tr(locale, "Chọn tài nguyên để chèn vào cột đang làm việc", "Choose an asset to insert into the active column") : type === "review" ? tr(locale, "Xử lý lần lượt các vấn đề ảnh hưởng tới email", "Resolve email-impacting issues one by one") : type === "history" ? tr(locale, "Timeline bất biến, có thể tạo bản nháp mới", "Immutable timeline with safe draft restoration") : tr(locale, "Dùng cùng nguồn dữ liệu với canvas", "Driven by the same canvas data")}</small></div><button className="v3-workspace-size" title={expanded ? tr(locale, "Thu về kích thước chuẩn", "Use standard width") : tr(locale, "Mở rộng không gian làm việc", "Expand workspace")} onClick={toggleExpanded}>{expanded ? "↘" : "↗"}</button><button aria-label={tr(locale, "Đóng bảng công cụ", "Close workspace")} onClick={close}>×</button></header><div className="v3-sheet-body">
 {type === "templates" && <><div className="v3-sheet-toolbar"><label className="v3-search">⌕<input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={tr(locale, "Tìm mẫu theo tên hoặc mục đích", "Search by name or purpose")}/></label><div className="v3-view-note">{templatePresets.length} {tr(locale, "mẫu sẵn sàng", "ready templates")}</div></div><div className="v3-template-browser"><button className="v3-template-blank-card" onClick={createBlank}><span className="v3-template-blank-hero">＋<strong>{tr(locale, "Canvas trống", "Blank canvas")}</strong></span><span><small>{tr(locale, "BẮT ĐẦU TỰ DO", "START FREELY")}</small><b>{tr(locale, "Email trắng", "Blank email")}</b><p>{tr(locale, "Một Section và Column trống, sẵn sàng ghép element theo nhu cầu.", "A valid empty Section and Column ready for free composition.")}</p><em>0 {tr(locale, "khối dựng sẵn", "preset blocks")}</em></span><strong>{tr(locale, "Tạo email", "Create email")} →</strong></button>{templatePresets.filter(p => `${p.vi} ${p.en} ${p.descVi} ${p.descEn}`.toLowerCase().includes(q.toLowerCase())).map(p => <button key={p.id} onClick={() => applyTemplate(p)}><span className={`v3-template-hero ${p.tone}`}><i /><b /><em /><small /><strong>{tr(locale, "Xem nhanh", "Preview")}</strong></span><span><small>{p.category === "hr" ? tr(locale, "NHÂN SỰ", "HR") : p.category === "internal" ? tr(locale, "NỘI BỘ", "INTERNAL") : tr(locale, "SỰ KIỆN", "EVENT")}</small><b>{tr(locale, p.vi, p.en)}</b><p>{tr(locale, p.descVi, p.descEn)}</p><em>{p.blocks} {tr(locale, "khối · Email-first", "blocks · Email-first")}</em></span><strong>{tr(locale, "Dùng mẫu", "Use template")} →</strong></button>)}</div></>}
 {type === "variables" && <><div className="v3-sheet-toolbar variable-tools"><label className="v3-search">⌕<input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={tr(locale, "Tìm theo tên, mã hoặc giá trị mẫu", "Search name, key or sample value")}/><kbd>⌘ K</kbd></label><div className="v3-scope-tabs">{(["all", "recipient", "shared", "system", "template"] as const).map(scope => <button key={scope} className={variableScope === scope ? "active" : ""} onClick={() => setVariableScope(scope)}>{scope === "all" ? tr(locale, "Tất cả", "All") : scope === "recipient" ? tr(locale, "Người nhận", "Recipient") : scope === "shared" ? tr(locale, "Dùng chung", "Shared") : scope === "system" ? tr(locale, "Hệ thống", "System") : tr(locale, "Template", "Template")}</button>)}</div></div><div className="v3-context-card"><span>◎</span><div><small>{tr(locale, "DỮ LIỆU XEM TRƯỚC", "PREVIEW DATA")}</small><b>Nguyễn Thu Hà · {tr(locale, "Nhân sự", "People")}</b></div><button onClick={() => notify(tr(locale, "Đã mở xem trước người nhận", "Recipient preview opened"))}>{tr(locale, "Đổi người", "Change")}</button></div>{(["recipient", "shared", "system", "template"] as const).map(scope => { const vs = doc.variables.filter(v => (variableScope === "all" || variableScope === scope) && v.scope === scope && `${v.name} ${v.key} ${v.fallback}`.toLowerCase().includes(q.toLowerCase())); return vs.length ? <section className="v3-var-group modern" key={scope}><h3>{scope === "recipient" ? tr(locale, "Dữ liệu người nhận", "Recipient data") : scope === "shared" ? tr(locale, "Dùng chung", "Shared") : scope === "system" ? tr(locale, "Hệ thống", "System") : tr(locale, "Riêng template này", "This template")}<span>{vs.length}</span></h3>{vs.map(v => <button key={v.key} onClick={() => insertVar(v)}><span>◇</span><div><b>{v.name}</b><code>{`{{${v.key}}}`}</code><small>{tr(locale, "Giá trị mẫu", "Sample")}: {v.fallback}</small></div><em>{v.required && <i>{tr(locale, "Bắt buộc", "Required")}</i>}{v.campaignOverride && <i>{tr(locale, "Ghi đè", "Override")}</i>}</em><strong>＋</strong></button>)}</section> : null; })}<div className="v3-sheet-actionbar"><span>{active && ["text", "heading", "button", "contact", "preheader"].includes(active.kind) ? tr(locale, `Sẽ chèn vào: ${nodeName(active, locale)}`, `Insert into: ${nodeName(active, locale)}`) : tr(locale, "Chọn một khối văn bản để chèn biến", "Select a text component to insert")}</span><button onClick={() => notify(tr(locale, "Đã mở trình tạo biến riêng template", "Template variable creator opened"))}>＋ {tr(locale, "Tạo biến", "New variable")}</button></div></>}
 {type === "assets" && <><div className="v3-sheet-toolbar asset-tools"><label className="v3-search">⌕<input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={assetTarget?.accept === "logo" ? tr(locale, "Tìm trong kho logo", "Search brand logos") : assetTarget?.accept === "image" ? tr(locale, "Tìm hình ảnh", "Search images") : tr(locale, "Tìm ảnh, logo hoặc tên tệp", "Search images, logos or filenames")}/></label><label className="v3-upload">⇧ {tr(locale, "Tải lên và dùng", "Upload & use")}<input type="file" accept="image/*" onChange={e => { const file = e.target.files?.[0]; if (!file)
        return; const reader = new FileReader(); reader.onload = () => pickAsset({ id: uid("upload"), name: file.name, type: assetTarget?.accept === "logo" || assetFilter === "logo" ? "logo" : "image", src: String(reader.result), tone: "sage", size: `${Math.round(file.size / 1024)} KB` }); reader.readAsDataURL(file); }}/></label></div><div className="v3-asset-filterbar"><div>{(["all", "image", "logo"] as const).filter(f => assetTarget?.accept === "all" || !assetTarget?.accept || f === assetTarget.accept).map(f => <button key={f} className={assetFilter === f ? "active" : ""} onClick={() => setAssetFilter(f)}>{f === "all" ? tr(locale, "Tất cả", "All") : f === "image" ? tr(locale, "Hình ảnh phù hợp", "Compatible images") : tr(locale, "Logo phù hợp", "Compatible logos")}</button>)}</div><span>{assets.filter(a => (assetTarget?.accept === "all" || !assetTarget?.accept || a.type === assetTarget.accept) && (assetFilter === "all" || a.type === assetFilter)).length} {tr(locale, "tài nguyên có thể dùng", "compatible assets")}</span></div>{(assetTarget?.accept === "all" || assetTarget?.accept === "logo") && <button className="v3-brand-kit" onClick={() => setAssetFilter("logo")}><span>A</span><div><b>Altasoftware Brand Kit</b><small>{tr(locale, "Logo đã duyệt cho email nội bộ", "Approved logos for internal email")}</small></div><em>{tr(locale, "Chỉ xem logo", "Show logos")} →</em></button>}<div className="v3-assets modern">{assets.filter(a => (assetTarget?.accept === "all" || !assetTarget?.accept || a.type === assetTarget.accept) && (assetFilter === "all" || a.type === assetFilter) && a.name.toLowerCase().includes(q.toLowerCase())).map(a => <button className={targetNode?.assetId === a.id ? "selected" : ""} key={a.id} onClick={() => pickAsset(a)}><span className={a.tone}>{a.type === "logo" ? <img src={a.src} alt={a.name}/> : <img src={a.src} alt={a.name}/>}<i>{a.type === "logo" ? "LOGO" : "IMAGE"}</i>{targetNode?.assetId === a.id && <strong>✓ {tr(locale, "Đang dùng", "In use")}</strong>}</span><div><b>{a.name}</b><small>{a.type === "logo" ? tr(locale, "Tài sản thương hiệu đã duyệt", "Approved brand asset") : a.size}</small><em>＋</em></div></button>)}</div><div className="v3-sheet-actionbar"><span>{assetTarget?.mode === "replace" && targetNode ? tr(locale, `Chọn để thay ngay trong ${nodeName(targetNode, locale)}`, `Choose to replace ${nodeName(targetNode, locale)} immediately`) : tr(locale, "Chọn một tài nguyên để chèn vào cột đang làm việc", "Choose an asset to insert into the active column")}</span><button className="secondary" onClick={close}>{tr(locale, "Hủy chọn", "Cancel")}</button></div></>}
 {type === "review" && <><div className={`v3-review-summary ${issues.length ? "bad" : "clean"}`}><span>{issues.length || "✓"}</span><div><small>{tr(locale, "MỨC SẴN SÀNG", "READINESS")}</small><b>{issues.length ? tr(locale, `${issues.length} mục cần xử lý trước khi gửi`, `${issues.length} item(s) before sending`) : tr(locale, "Nội dung đã sẵn sàng", "Content is ready")}</b><p>{tr(locale, "Soát theo tác động thực tế: liên kết, hình ảnh, dữ liệu và khả năng đọc.", "Review by real impact: links, images, data and readability.")}</p><i><em style={{ width: `${Math.max(18, 100 - issues.length * 22)}%` }}/></i></div></div><div className="v3-review-filters">{(["all", "error", "warn"] as const).map(f => <button key={f} className={reviewFilter === f ? "active" : ""} onClick={() => setReviewFilter(f)}>{f === "all" ? tr(locale, "Tất cả", "All") : f === "error" ? tr(locale, "Cần sửa", "Errors") : tr(locale, "Nên xem", "Warnings")}<span>{f === "all" ? issues.length : issues.filter(x => x.level === f).length}</span></button>)}</div><div className="v3-issues modern">{issues.filter(x => reviewFilter === "all" || x.level === reviewFilter).map((x, i) => <button key={i} onClick={() => selectIssue(x.nodeId)}><span className={x.level}>!</span><div><small>{x.level === "error" ? tr(locale, "CẦN SỬA", "ERROR") : tr(locale, "NÊN XEM", "WARNING")}</small><b>{x.title}</b><p>{x.detail}</p><em>{tr(locale, "Đi tới khối và sửa", "Go to component and fix")} →</em></div></button>)}{!issues.length && <p className="no-issues">✓ {tr(locale, "Không tìm thấy lỗi cần xử lý", "No issues found")}</p>}</div>{issues.length > 0 && <div className="v3-sheet-actionbar review-action"><span>{tr(locale, "Ưu tiên lỗi có thể làm email bị trống", "Prioritizing email-blocking issues")}</span><button onClick={() => selectIssue((issues.find(x => x.level === "error") || issues[0]).nodeId)}>{tr(locale, "Sửa mục tiếp theo", "Fix next")} →</button></div>}</>}
 {type === "preview" && <div className="v3-preview-work"><aside><h3>{tr(locale, "Người nhận", "Recipients")}</h3>{people.map((p, i) => <button className={recipient === i ? "active" : ""} onClick={() => setRecipient(i)} key={p.name}><span>{p.name.split(" ").at(-1)?.[0]}</span><div><b>{p.name}</b><small>{p.dept}</small></div>{p.dept === "—" && <em>!</em>}</button>)}</aside><div className="v3-inbox"><header><span>● ● ●</span><b>{tr(locale, "Hộp thư doanh nghiệp", "Business inbox")}</b><small>{people[recipient].name}</small></header><div><div dangerouslySetInnerHTML={{ __html: html.replace(/<!doctype html>|<\/?html>|<\/?body[^>]*>/gi, "").replace(/\{\{ten_nhan_vien\}\}/g, people[recipient].name).replace(/\{\{phong_ban\}\}/g, people[recipient].dept).replace(/\{\{ten_cong_ty\}\}/g, "Altasoftware") }}/></div></div></div>}
 {type === "history" && <><div className="v3-immutable"><span>⌾</span><div><b>{tr(locale, "Lịch sử an toàn tuyệt đối", "An immutable audit trail")}</b><p>{tr(locale, "Bản đã xuất bản không thể sửa. Khôi phục luôn tạo một bản nháp mới.", "Published versions cannot be edited. Restoring always creates a new draft.")}</p></div></div><div className="v3-history-toolbar"><div><button className="active">{tr(locale, "Phiên bản", "Versions")}</button><button onClick={() => notify(tr(locale, "Đã mở nhật ký hoạt động", "Activity log opened"))}>{tr(locale, "Hoạt động", "Activity")}</button></div><button onClick={() => notify(tr(locale, "Đã bật chế độ so sánh", "Comparison mode enabled"))}>⇄ {tr(locale, "So sánh", "Compare")}</button></div><div className="v3-versions timeline">{[["v5", tr(locale, "Bản nháp hiện tại", "Current draft"), "26/08 · 10:18", "DC"], ["v4", tr(locale, "Đã xuất bản", "Published"), "25/08 · 16:42", "DC"], ["v3", tr(locale, "Đã xuất bản", "Published"), "22/08 · 09:30", "LN"], ["v2", tr(locale, "Đã xuất bản", "Published"), "18/08 · 14:06", "MT"]].map((v, i) => <button className={selectedVersion === i ? "selected" : ""} key={v[0]} onClick={() => setSelectedVersion(i)}><i /><div><span><b>{v[0]}</b><em className={i ? "locked" : "editing"}>{i ? `⌾ ${v[1]}` : v[1]}</em></span><small>{v[2]} · {v[3]}</small><p>{i === 0 ? tr(locale, "Đang tự động lưu thay đổi trên canvas", "Autosaving current canvas changes") : i === 1 ? tr(locale, "Bản dùng cho chiến dịch chào mừng tháng 8", "Used by the August welcome campaign") : tr(locale, "Bản ghi nội dung đã gửi", "Snapshot of sent content")}</p></div><strong>{selectedVersion === i ? "✓" : "›"}</strong></button>)}</div><div className="v3-history-selection"><span>{tr(locale, "ĐANG CHỌN", "SELECTED")}</span><b>{selectedVersion === 0 ? tr(locale, "Bản nháp hiện tại", "Current draft") : `v${5 - selectedVersion} · ${tr(locale, "Bản bất biến", "Immutable version")}`}</b><small>{selectedVersion === 0 ? tr(locale, "Bản này đang được chỉnh sửa", "This version is being edited") : tr(locale, "Có thể xem, so sánh hoặc tạo bản nháp mới", "Available to view, compare or restore as a draft")}</small></div><div className="v3-sheet-actionbar history-action"><button className="secondary" onClick={() => notify(tr(locale, "Đã mở bản xem trước phiên bản", "Version preview opened"))}>{tr(locale, "Xem phiên bản", "View version")}</button><button disabled={selectedVersion === 0} onClick={() => { notify(tr(locale, "Đã tạo bản nháp mới từ phiên bản đã chọn", "New draft created from selected version")); close(); }}>＋ {tr(locale, "Tạo bản nháp mới", "Create new draft")}</button></div></>}
 {type === "publish" && <><div className={`v3-publish-ready ${issues.some(x => x.level === "error") ? "bad" : ""}`}><span>{issues.some(x => x.level === "error") ? "!" : "✓"}</span><div><b>{issues.some(x => x.level === "error") ? tr(locale, "Cần xử lý lỗi trước khi xuất bản", "Resolve errors before publishing") : tr(locale, "Resource sẵn sàng đồng bộ", "Resource is ready to sync")}</b><p>{tr(locale, "HTML, text thuần, biến và metadata được đóng gói thành phiên bản bất biến.", "HTML, plain text, variables and metadata are packaged as an immutable version.")}</p></div></div><div className="v3-resource"><div><span>Provider</span><b>mailcraft</b></div><div><span>Resource</span><b>email_template</b></div><div><span>Version</span><b>v5</b></div><div><span>Variables</span><b>{doc.variables.length}</b></div></div><div className="v3-flow"><span>Mailcraft</span><i>HTML + metadata</i><b>→</b><span>EOW Provider API</span></div><button className="v3-publish-confirm" disabled={issues.some(x => x.level === "error")}>{tr(locale, "Xuất bản và đồng bộ sang EOW", "Publish and sync to EOW")}</button></>}
 {type === "html" && <Code locale={locale} active={active} html={html} patch={patchActive}/>}</div></aside></div>;
}
function Code({ locale, active, html, patch }: {
    locale: Locale;
    active?: Node;
    html: string;
    patch: (p: Partial<Node>) => void;
}) { const custom = active?.kind === "custom", [tab, setTab] = useState<"html" | "css">("html"), [h, setH] = useState(custom ? active.html || "" : html), [css, setCss] = useState(custom ? active.css || "" : ""), blocked = /<script|<form|\son\w+\s*=|javascript:/i.test(h) || /@import|expression\s*\(/i.test(css), warnings = [!/<table\b/i.test(h) ? tr(locale, "Nên dùng table cho bố cục email.", "Use tables for stable email layouts.") : "", /href=["']#["']/i.test(h) ? tr(locale, "Có liên kết mẫu #.", "A placeholder # link remains.") : ""].filter(Boolean); return <div className="v3-code-work"><div className="v3-pipeline">{["Parse", "Sanitize", "Validate", "Preview"].map((x, i) => <div className={!blocked ? "done" : i === 0 ? "active" : ""} key={x}><span>{!blocked ? "✓" : i + 1}</span><b>{x}</b></div>)}</div><div className="v3-code-tabs"><button className={tab === "html" ? "active" : ""} onClick={() => setTab("html")}>HTML</button><button className={tab === "css" ? "active" : ""} onClick={() => setTab("css")}>CSS</button><span>{"{{ten_bien}}"}</span></div><textarea spellCheck={false} value={tab === "html" ? h : css} onChange={e => tab === "html" ? setH(e.target.value) : setCss(e.target.value)}/><div className={`v3-code-result ${blocked ? "error" : warnings.length ? "warn" : "ok"}`}>{blocked ? `⊘ ${tr(locale, "Nội dung thực thi bị chặn", "Executable content blocked")}` : warnings.length ? `⚠ ${warnings.join(" ")}` : `✓ ${tr(locale, "Mã sẵn sàng áp dụng", "Code ready to apply")}`}</div>{custom && <button className="v3-apply-code" disabled={blocked} onClick={() => patch({ html: cleanHtml(h), css: cleanCss(css) })}>{tr(locale, "Áp dụng vào khối", "Apply to block")}</button>}</div>; }
