/*
 * Mall Manager backoffice capture hook.
 *
 * This relay override intentionally does only one job: capture KoL's real
 * backoffice page with no-argument visit_url(), save a sanitized local copy,
 * and pass the native page through unchanged. Sales parsing/CSV generation is
 * owned by relay_store_reprice.js so ASH runtime quirks cannot drop sales.
 */

string sanitize_debug_html(string value) {
	value = replace_all(create_matcher("pwd=[^&\\\"' <>]*", value), "pwd=REDACTED");
	value = replace_all(create_matcher("pwdhash=[^&\\\"' <>]*", value), "pwdhash=REDACTED");

	value = replace_all(
		create_matcher("var\\s+pwd\\s*=\\s*[^;]+;", value),
		"var pwd = 'REDACTED';"
	);
	value = replace_all(
		create_matcher("var\\s+pwdhash\\s*=\\s*[^;]+;", value),
		"var pwdhash = 'REDACTED';"
	);

	return value;
}

boolean write_debug_html(buffer page) {
	buffer debug;
	debug.append(sanitize_debug_html(page.to_string()));
	return buffer_to_file(debug, "mall-manager-backoffice-debug.html");
}

void main() {
	buffer page = visit_url();
	string page_text = page.to_string();
	boolean is_store_log = contains_text(page_text, "Recent Store Activity");
	boolean saved = write_debug_html(page);

	set_property("mallManagerSalesLastHookMs", now_to_int());
	set_property("mallManagerSalesLastHookPageChars", length(page_text));
	set_property("mallManagerSalesLastHookParsedCount", 0);
	set_property(
		"mallManagerSalesLastHookLookedLikeStoreLog",
		is_store_log ? "true" : "false"
	);
	set_property(
		"mallManagerSalesLastHookWriteOk",
		saved ? "true" : "false"
	);

	if (form_field("mallmanager_sync") == "1") {
		write("Mall Manager sales capture complete.");
		return;
	}

	write(page);
}
