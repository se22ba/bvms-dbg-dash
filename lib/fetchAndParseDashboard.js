import path from "path";

function detectExtension(rel, contentType, raw) {
  const relPath = String(rel || "").split("?")[0].split("#")[0];
  let ext = path.extname(relPath);
  if (ext) {
    ext = ext.toLowerCase();
    if (ext === ".mht") return ".mhtml";
    return ext;
  }

  const type = String(contentType || "").toLowerCase();
  if (type.includes("multipart/related") || type.includes("application/x-mimearchive")) {
    return ".mhtml";
  }
  if (type.includes("text/html") || type.includes("application/xhtml+xml")) {
    return ".html";
  }

  const body = typeof raw === "string" ? raw.slice(0, 4096).toLowerCase() : "";
  if (body.includes("content-type: multipart/related")) return ".mhtml";
  if (body.includes("mime-version: 1.0") && body.includes("boundary=")) return ".mhtml";

  return ".html";
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeText(body, transferEncoding, charset) {
  const encoding = String(transferEncoding || "").toLowerCase();
  let buffer;

  if (encoding.includes("base64")) {
    const clean = body.replace(/\s+/g, "");
    buffer = Buffer.from(clean, "base64");
  } else if (encoding.includes("quoted-printable")) {
    const decoded = decodeQuotedPrintable(body);
    buffer = Buffer.from(decoded, "binary");
  } else {
    buffer = Buffer.from(body, "binary");
  }

  const cs = String(charset || "utf-8").toLowerCase();
  try {
    if (cs === "utf-8" || cs === "utf8") return buffer.toString("utf8");
    if (cs === "iso-8859-1" || cs === "latin1" || cs === "latin-1" || cs === "windows-1252") {
      return buffer.toString("latin1");
    }
    if (cs === "us-ascii" || cs === "ascii") return buffer.toString("ascii");
    return buffer.toString("utf8");
  } catch {
    return buffer.toString("utf8");
  }
}

function extractPrimaryHtml(rawInput, { contentType, ext } = {}) {
  const raw = Buffer.isBuffer(rawInput) ? rawInput.toString("utf8") : String(rawInput ?? "");
  const type = String(contentType || "").toLowerCase();
  const extension = String(ext || "").toLowerCase();
  const looksLikeMhtml =
    extension === ".mhtml" ||
    extension === ".mht" ||
    type.includes("multipart/related") ||
    raw.includes("Content-Type: multipart/related");

  if (!looksLikeMhtml) return raw;

  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType || "");
  const boundary = boundaryMatch?.[1] || (() => {
    const m = raw.match(/\r?\n--([^\r\n]+)\r?\ncontent-type:/i);
    return m?.[1];
  })();

  if (!boundary) return raw;

  const delimiter = `--${boundary}`;
  const sections = raw.split(delimiter);
  for (const section of sections) {
    let part = section.trim();
    if (!part || part === "--") continue;
    if (part.startsWith("--")) part = part.slice(2).trim();

    const splitIndex = part.search(/\r?\n\r?\n/);
    if (splitIndex === -1) continue;

    const headerBlock = part.slice(0, splitIndex).trim();
    const body = part.slice(splitIndex).replace(/^\r?\n\r?\n/, "");

    const headerLines = headerBlock.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const headers = {};
    headerLines.forEach(line => {
      const idx = line.indexOf(":");
      if (idx === -1) return;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      headers[key] = value;
    });

    const partType = String(headers["content-type"] || "").toLowerCase();
    if (!partType.includes("text/html")) continue;

    const charsetMatch = headers["content-type"]?.match(/charset="?([^";]+)"?/i);
    const charset = charsetMatch?.[1];
    const transfer = headers["content-transfer-encoding"];

    try {
      const html = decodeMimeText(body, transfer, charset);
      if (html.trim()) return html;
    } catch {}
  }

  return raw;
}

function isMhtmlSource({ ext, contentType, raw }) {
  const extNorm = String(ext || "").toLowerCase();
  if (extNorm === ".mhtml" || extNorm === ".mht") return true;

  const type = String(contentType || "").toLowerCase();
  if (type.includes("multipart/related") || type.includes("application/x-mimearchive")) return true;

  const snippet = typeof raw === "string" ? raw.slice(0, 4096).toLowerCase() : "";
  if (snippet.includes("content-type: multipart/related")) return true;
  if (snippet.includes("mime-version: 1.0") && snippet.includes("boundary=")) return true;

  return false;
}

function convertDashboardContent({ raw, contentType, ext, html }) {
  const rawString = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  const baseHtml = html != null ? html : extractPrimaryHtml(rawString, { contentType, ext });
  const convertedFromMhtml = isMhtmlSource({ ext, contentType, raw: rawString });
  const finalExt = convertedFromMhtml ? ".htm" : (ext || ".htm");
  return { html: baseHtml, ext: finalExt, convertedFromMhtml };
}

async function fetchAndParseDashboard({
  downloader,
  host,
  candidates,
  user,
  pass,
  progress,
  logicalName = "bosch-vrm",
  parseDashboard,
  onConverted
}) {
  if (typeof downloader !== "function") {
    throw new Error("downloader function is required");
  }

  const response = await downloader({ host, logicalName, candidates, user, pass, progress });
  if (!response || !response.ok) return response;

  const conversion = convertDashboardContent({
    raw: response.raw ?? response.html ?? "",
    html: response.html,
    ext: response.ext,
    contentType: response.contentType
  });

  if (conversion.convertedFromMhtml && typeof onConverted === "function") {
    onConverted(conversion);
  }

  let dashboard = null;
  let parseError = null;
  if (typeof parseDashboard === "function") {
    try {
      dashboard = parseDashboard(conversion.html);
    } catch (err) {
      parseError = err;
    }
  }

  return {
    ok: true,
    html: conversion.html,
    ext: conversion.ext,
    dashboard,
    scheme: response.scheme,
    rel: response.rel,
    convertedFromMhtml: conversion.convertedFromMhtml,
    parseError
  };
}

function parseDashboardUpload({ fileName, content, parseDashboard, onConverted }) {
  const raw = Buffer.isBuffer(content) ? content.toString("utf8") : String(content ?? "");
  const ext = detectExtension(fileName, null, raw);
  const conversion = convertDashboardContent({ raw, ext });

  if (conversion.convertedFromMhtml && typeof onConverted === "function") {
    onConverted(conversion);
  }

  let dashboard = null;
  let parseError = null;
  if (typeof parseDashboard === "function") {
    try {
      dashboard = parseDashboard(conversion.html);
    } catch (err) {
      parseError = err;
    }
  }

  return {
    html: conversion.html,
    ext: conversion.ext,
    dashboard,
    convertedFromMhtml: conversion.convertedFromMhtml,
    parseError
  };
}

export {
  detectExtension,
  extractPrimaryHtml,
  fetchAndParseDashboard,
  parseDashboardUpload,
  convertDashboardContent
};