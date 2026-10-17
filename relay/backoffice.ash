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
	return trim(replace_all(create_matcher("\\s+", value), " "));
}

int comma_int(string value) {
	return replace_string(value, ",", "").to_int();
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

		if (!m.find()) {
			continue;
		}

		int quantity = comma_int(m.group(4));
		int total_meat = comma_int(m.group(6));

		if (quantity <= 0 || total_meat < 0) {
			continue;
		}

		int n = count(sales);
		sales[n].date = m.group(1);
		sales[n].time = m.group(2);
		sales[n].player = normalize_space(m.group(3));
		sales[n].item_name = normalize_space(m.group(5));
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

	if (form_field("which") != "3") {
		write(page);
		return;
	}

	mall_sale[int] sales = parse_store_log(page);
	boolean saved = write_current_csv(sales);

	if (form_field("mallmanager_sync") == "1") {
		string status = saved ? "ok" : "write_failed";
		write(
			"<!doctype html><html><head>" +
			"<meta charset='utf-8'>" +
			"<meta http-equiv='refresh' content='0;url=/relay_store_reprice.js?sync=" + status + "'>" +
			"<title>Mall Manager sales sync</title>" +
			"</head><body>" +
			"Captured " + count(sales) + " Store Log transaction(s). " +
			"<a href='/relay_store_reprice.js?sync=" + status + "'>Return to Mall Manager</a>" +
			"</body></html>"
		);
		return;
	}

	write(page);
}
