/*
 * Mall Manager backoffice capture hook.
 *
 * This relay override is intentionally small: fetch the real KoL backoffice
 * response with no-argument visit_url(), capture Store Log sales from which=3
 * into a CSV in KoLmafia/data, then pass the native page through unchanged.
 *
 * A request with mallmanager_sync=1 captures the CSV and redirects back to the
 * Mall Manager dashboard, giving the dashboard a reliable one-click refresh
 * without making nested backoffice requests from inside the dashboard relay.
 *
 * Parsing is based on the proven transaction shape used by:
 * https://github.com/jimmyking9999999/kol-relay-projects
 */

record mall_sale {
	string date;
	string time;
	string player;
	string item_name;
	int quantity;
	int item_price;
	int total_meat;
};

string csv_escape(string value) {
	return "\"" + replace_string(value, "\"", "\"\"") + "\"";
}

string strip_tags(string value) {
	return replace_all(create_matcher("<[^>]*>", value), "");
}

string normalize_space(string value) {
	value = replace_string(value, "&nbsp;", " ");
	value = replace_all(create_matcher("\\s+", value), " ");
	value = replace_all(create_matcher("^\\s+|\\s+$", value), "");
	return value;
}

int comma_int(string value) {
	return replace_string(value, ",", "").to_int();
}

string sanitize_debug_html(string value) {
	value = replace_all(create_matcher("pwd=[^&\\\"' <>]*", value), "pwd=REDACTED");
	value = replace_all(create_matcher("pwdhash=[^&\\\"' <>]*", value), "pwdhash=REDACTED");

	// KoL also embeds the session password hash in page JavaScript.
	// Match the whole assignment through its semicolon so replacement strings
	// do not depend on quote-escape behavior in older ASH runtimes.
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

mall_sale[int] parse_store_log(buffer page) {
	mall_sale[int] sales;

	/*
	 * Parse with literal delimiters instead of a transaction regex.
	 *
	 * KoL's Store Log has a stable shape:
	 *   DATE TIME <a...><b>PLAYER</b></a> bought QTY (ITEM) for TOTAL Meat.
	 *
	 * Splitting on "Meat." leaves one sale at the end of each chunk. Literal
	 * string operations are intentionally used here for compatibility with
	 * older KoLmafia ASH runtimes.
	 */
	string[int] chunks = split_string(page.to_string(), "Meat\\.");

	foreach i, raw in chunks {
		int bought_at = last_index_of(raw, " bought ");
		if (bought_at < 0) {
			continue;
		}

		int player_open = last_index_of(raw, "<b>", bought_at);
		int player_close =
			player_open >= 0 ? index_of(raw, "</b>", player_open + 3) : -1;

		if (
			player_open < 0 ||
			player_close < 0 ||
			player_close > bought_at
		) {
			continue;
		}

		string player =
			normalize_space(substring(raw, player_open + 3, player_close));

		string after_bought = substring(raw, bought_at + length(" bought "));
		int qty_end = index_of(after_bought, " (");
		int item_end =
			qty_end >= 0
				? index_of(after_bought, ") for ", qty_end + 2)
				: -1;

		if (qty_end < 0 || item_end < 0) {
			continue;
		}

		string quantity_text =
			normalize_space(substring(after_bought, 0, qty_end));
		string item_name =
			normalize_space(
				substring(after_bought, qty_end + 2, item_end)
			);
		string total_text =
			normalize_space(
				substring(after_bought, item_end + length(") for "))
			);

		int quantity = comma_int(quantity_text);
		int total_meat = comma_int(total_text);

		if (
			player == "" ||
			item_name == "" ||
			quantity <= 0 ||
			total_meat < 0
		) {
			continue;
		}

		string sale_date = "";
		string sale_time = "";

		/*
		 * The date/time sit immediately before the player's <a> tag.
		 * They are useful metadata, but failure to recover them must not
		 * discard an otherwise valid transaction.
		 */
		int anchor_open = last_index_of(raw, "<a", bought_at);
		if (anchor_open >= 0) {
			int previous_tag_end = last_index_of(raw, ">", anchor_open);

			if (previous_tag_end >= 0) {
				string stamp =
					normalize_space(
						substring(
							raw,
							previous_tag_end + 1,
							anchor_open
						)
					);

				int stamp_space = index_of(stamp, " ");
				if (stamp_space > 0) {
					sale_date =
						substring(stamp, 0, stamp_space);
					sale_time =
						normalize_space(
							substring(stamp, stamp_space + 1)
						);
				}
			}
		}

		int n = count(sales);
		sales[n].date = sale_date;
		sales[n].time = sale_time;
		sales[n].player = player;
		sales[n].item_name = item_name;
		sales[n].quantity = quantity;
		sales[n].item_price = total_meat / quantity;
		sales[n].total_meat = total_meat;
	}

	return sales;
}

boolean write_current_csv(mall_sale[int] sales) {
	buffer out;
	out.append("\"Date\",\"Time\",\"Player\",\"Item\",\"Quantity\",\"Item Price\",\"Total Meat\"\n");

	foreach i, sale in sales {
		out.append(csv_escape(sale.date));
		out.append(",");
		out.append(csv_escape(sale.time));
		out.append(",");
		out.append(csv_escape(sale.player));
		out.append(",");
		out.append(csv_escape(sale.item_name));
		out.append(",");
		out.append(sale.quantity);
		out.append(",");
		out.append(sale.item_price);
		out.append(",");
		out.append(sale.total_meat);
		out.append("\n");
	}

	boolean ok = buffer_to_file(out, "mall-manager-sales-current.csv");

	if (ok) {
		set_property("mallManagerSalesLastCaptureMs", now_to_int());
		set_property("mallManagerSalesLastCaptureCount", count(sales));
	}

	return ok;
}

void main() {
	buffer page = visit_url();

	// Always retain a sanitized local copy of the exact page the hook received.
	// This is diagnostic evidence for parser failures and never contains the
	// KoL pwd/pwdhash query values.
	write_debug_html(page);

	mall_sale[int] sales = parse_store_log(page);
	string page_text = page.to_string();
	boolean is_store_log =
		contains_text(page_text, "Recent Store Activity") ||
		count(sales) > 0;

	boolean saved = false;
	if (is_store_log && count(sales) > 0) {
		saved = write_current_csv(sales);
	}

	set_property("mallManagerSalesLastHookMs", now_to_int());
	set_property("mallManagerSalesLastHookPageChars", length(page_text));
	set_property("mallManagerSalesLastHookParsedCount", count(sales));
	set_property("mallManagerSalesLastHookLookedLikeStoreLog", is_store_log ? "true" : "false");
	set_property("mallManagerSalesLastHookWriteOk", saved ? "true" : "false");

	// For Mall Manager's hidden-iframe refresh flow, do not attempt a redirect
	// from inside this relay override. The parent dashboard reloads itself after
	// this request finishes.
	if (form_field("mallmanager_sync") == "1") {
		write("Mall Manager sales capture complete.");
		return;
	}

	write(page);
}
