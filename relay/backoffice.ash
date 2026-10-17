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
	return value;
}

boolean write_debug_html(buffer page) {
	buffer debug;
	debug.append(sanitize_debug_html(page.to_string()));
	return buffer_to_file(debug, "mall-manager-backoffice-debug.html");
}

mall_sale[int] parse_store_log(buffer page) {
	mall_sale[int] sales;
	string[int] chunks = split_string(page.to_string(), "Meat.");

	foreach i, raw in chunks {
		string text = normalize_space(strip_tags(raw));

		matcher m = create_matcher(
			"(\\d{1,2}/\\d{1,2}/(?:\\d{2}|\\d{4}))\\s+" +
			"(\\d{1,2}:\\d{2}:\\d{2})\\s+" +
			"(.+?)\\s+bought\\s+" +
			"([\\d,]+)\\s+\\((.*?)\\)\\s+for\\s+([\\d,]+)",
			text
		);

		string sale_date;
		string sale_time;
		string sale_player;
		string sale_item;
		string sale_quantity;
		string sale_total;

		if (m.find()) {
			sale_date = m.group(1);
			sale_time = m.group(2);
			sale_player = m.group(3);
			sale_quantity = m.group(4);
			sale_item = m.group(5);
			sale_total = m.group(6);
		} else {
			// JimmyKing-style fallback: anchor on the timestamp and sale sentence.
			matcher fallback = create_matcher(
				"(\\d{1,2}:\\d{2}:\\d{2})\\s+" +
				"(.+?)\\s+bought\\s+" +
				"([\\d,]+)\\s+\\((.*?)\\)\\s+for\\s+([\\d,]+)",
				text
			);

			if (!fallback.find()) {
				continue;
			}

			matcher date_match = create_matcher(
				"(\\d{1,2}/\\d{1,2}/(?:\\d{2}|\\d{4}))",
				text
			);

			sale_date = date_match.find() ? date_match.group(1) : "";
			sale_time = fallback.group(1);
			sale_player = fallback.group(2);
			sale_quantity = fallback.group(3);
			sale_item = fallback.group(4);
			sale_total = fallback.group(5);
		}

		int quantity = comma_int(sale_quantity);
		int total_meat = comma_int(sale_total);

		if (quantity <= 0 || total_meat < 0) {
			continue;
		}

		int n = count(sales);
		sales[n].date = sale_date;
		sales[n].time = sale_time;
		sales[n].player = normalize_space(sale_player);
		sales[n].item_name = normalize_space(sale_item);
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

	boolean saved = true;
	if (is_store_log) {
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
