const FORBIDDEN_TAGS = new Set([
	'script', 'style', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'form',
]);

const FORBIDDEN_ATTR_PREFIXES = ['on'];

const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'data', 'poster']);

const SAFE_URL_SCHEMES = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;
const SAFE_DATA_URL = /^data:image\//i;

/**
 * Strip an allowlist-violating subset of HTML produced by upstream Remarkup
 * rendering. Phabricator already sanitizes server-side; this is defense in
 * depth so a future server bug cannot inject scripts into our webview.
 *
 * - drops `<script>`, `<style>`, `<iframe>`, etc. (and their inner content)
 * - strips `on*` attributes
 * - rewrites unsafe `href` / `src` schemes (`javascript:`, etc.) to `#`
 * - leaves benign tags and `class`/`style` attributes alone
 */
export function sanitizeRenderedHtml(html: string): string {
	const parsed = parseHtml(html);
	return serialize(parsed);
}

/**
 * Rewrite root-relative URLs (`/F123/`, `/D456`) into absolute URLs against
 * the given Phabricator base URL so they resolve correctly inside a webview
 * whose document origin is the extension, not phabricator.
 */
export function rewriteRelativeUrls(html: string, baseUrl: string): string {
	const origin = baseUrlToOrigin(baseUrl);
	if (!origin) return html;
	return html.replace(/(href|src)=("|')(\/[^"']*)\2/gi, (_match, attr, quote, path) => {
		return `${attr}=${quote}${origin}${path}${quote}`;
	});
}

function baseUrlToOrigin(baseUrl: string): string | null {
	try {
		const u = new URL(baseUrl);
		return `${u.protocol}//${u.host}`;
	} catch {
		return null;
	}
}

interface Node {
	kind: 'text' | 'tag' | 'self' | 'close' | 'raw';
	content: string;
}

function parseHtml(html: string): Node[] {
	const out: Node[] = [];
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt === -1) {
			out.push({ kind: 'text', content: html.slice(i) });
			break;
		}
		if (lt > i) {
			out.push({ kind: 'text', content: html.slice(i, lt) });
		}
		// HTML comments / CDATA: drop entirely
		if (html.startsWith('<!--', lt)) {
			const end = html.indexOf('-->', lt + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		const gt = html.indexOf('>', lt);
		if (gt === -1) {
			out.push({ kind: 'text', content: html.slice(lt) });
			break;
		}
		const inside = html.slice(lt + 1, gt).trim();
		i = gt + 1;
		if (inside.startsWith('!')) continue;
		if (inside.startsWith('/')) {
			const name = inside.slice(1).split(/\s+/)[0].toLowerCase();
			if (FORBIDDEN_TAGS.has(name)) continue;
			out.push({ kind: 'close', content: name });
			continue;
		}
		const selfClosing = inside.endsWith('/');
		const body = selfClosing ? inside.slice(0, -1).trim() : inside;
		const space = body.indexOf(' ');
		const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
		if (FORBIDDEN_TAGS.has(name)) {
			// Skip until matching close tag (or end of input).
			const closeIdx = findCloseTag(html, name, i);
			i = closeIdx === -1 ? html.length : closeIdx;
			continue;
		}
		const attrs = space === -1 ? '' : body.slice(space + 1);
		const sanitizedAttrs = sanitizeAttrs(attrs);
		out.push({ kind: selfClosing ? 'self' : 'tag', content: sanitizedAttrs ? `${name} ${sanitizedAttrs}` : name });
	}
	return out;
}

function findCloseTag(html: string, name: string, from: number): number {
	const lower = html.toLowerCase();
	const closeStart = `</${name}`;
	const idx = lower.indexOf(closeStart, from);
	if (idx === -1) return -1;
	const gt = html.indexOf('>', idx);
	return gt === -1 ? -1 : gt + 1;
}

function sanitizeAttrs(attrs: string): string {
	const out: string[] = [];
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(attrs)) !== null) {
		const rawName = m[1].toLowerCase();
		if (FORBIDDEN_ATTR_PREFIXES.some((p) => rawName.startsWith(p))) continue;
		const value = m[3] ?? m[4] ?? m[5];
		if (value === undefined) {
			out.push(rawName);
			continue;
		}
		let safeValue = value;
		if (URL_ATTRS.has(rawName)) {
			if (!isSafeUrl(safeValue)) safeValue = '#';
		}
		out.push(`${rawName}="${escapeAttr(safeValue)}"`);
	}
	return out.join(' ');
}

function isSafeUrl(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0) return true;
	if (SAFE_URL_SCHEMES.test(trimmed)) return true;
	if (SAFE_DATA_URL.test(trimmed)) return true;
	return false;
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function serialize(nodes: Node[]): string {
	let out = '';
	for (const n of nodes) {
		if (n.kind === 'text') out += n.content;
		else if (n.kind === 'tag') out += `<${n.content}>`;
		else if (n.kind === 'self') out += `<${n.content} />`;
		else if (n.kind === 'close') out += `</${n.content}>`;
	}
	return out;
}
