try {
    var params = JSON.parse(value);
    var req = new HttpRequest();

    function normalizeBaseUrl(url) {
        return (url || '').replace(/\/+$/, '');
    }

    function trim(s) {
        return (s === null || s === undefined) ? '' : String(s).replace(/^\s+|\s+$/g, '');
    }

    function httpOk(code) {
        return code >= 200 && code < 300;
    }

    function parseEventTagsMulti(csv) {
        var map = {};
        csv = trim(csv);
        if (!csv) return map;

        var parts = csv.split(',');
        for (var i = 0; i < parts.length; i++) {
            var item = trim(parts[i]);
            if (!item) continue;

            var idx = item.indexOf(':');
            if (idx === -1) idx = item.indexOf('=');
            if (idx === -1) continue;

            var k = trim(item.substring(0, idx));
            var v = trim(item.substring(idx + 1));
            if (!k) continue;

            if (!map[k]) map[k] = [];
            map[k].push(v);
        }
        return map;
    }

    function getRawTags(p) {
        var t = trim(p.event_tags);
        if (t) return t;

        var msg = String(p.message || p.alert_message || '');
        var m = msg.match(/(?:^|\n)\s*EVENT_TAGS\s*=\s*(.+)\s*(?:\n|$)/);
        if (m && m[1]) return trim(m[1]);

        return '';
    }

    function chooseQueue(rawTags) {
        var queue = 'NÃO CLASSIFICADO';
        if (!rawTags) return queue;

        var tagsMulti = parseEventTagsMulti(rawTags);
        var rtQueueList = tagsMulti.rt_queue || [];

        if (rtQueueList.length > 1) {
            throw 'Invalid event: multiple rt_queue tags found (' + rtQueueList.length + '). rt_queue=' +
                  JSON.stringify(rtQueueList) + ' event_tags=' + rawTags;
        }

        if (rtQueueList.length === 1) {
            var q = trim(rtQueueList[0]);
            if (q) queue = q;
        }

        return queue;
    }

    function extractPopFromHostGroups(groupsRaw) {
        groupsRaw = trim(groupsRaw);
        if (!groupsRaw) return '';

        var groups = groupsRaw.split(/\s*,\s*|\s*\n\s*/);

        for (var i = 0; i < groups.length; i++) {
            var g = trim(groups[i]);
            var m = g.match(/^ONU_(POP0[1-8])$/i);
            if (m && m[1]) {
                return m[1].toUpperCase();
            }
        }

        return '';
    }

    function escSql(s) {
        return String(s).replace(/'/g, "\\'");
    }

    function findOpenTicketId(base, ticketSql) {
        var url = base + "/tickets?query=" + encodeURIComponent(ticketSql);
        Zabbix.log(4, "[ RT webhook ] search: " + url);

        var resp = req.get(url);
        var code = req.getStatus();

        if (!httpOk(code)) {
            throw "RT search failed. HTTP " + code + " Response: " + resp;
        }

        var data;
        try {
            data = JSON.parse(resp);
        } catch (e) {
            throw "RT search: invalid JSON response. HTTP " + code + " Response: " + resp;
        }

        if (data && data.items && data.items.length > 0) {
            return String(data.items[0].id);
        }

        return "";
    }

    function replyToTicket(base, ticketId, subject, body) {
        var url = base + "/ticket/" + ticketId + "/correspond";
        var payload = {
            "Subject": "Atualização: " + subject,
            "Content": body,
            "ContentType": "text/plain"
        };

        Zabbix.log(4, "[ RT webhook ] correspond: POST " + url);

        var resp = req.post(url, JSON.stringify(payload));
        var code = req.getStatus();

        if (!httpOk(code)) {
            throw "RT correspond failed. HTTP " + code + " Response: " + resp;
        }

        return resp;
    }

    if (!params.rt_url) throw "Missing rt_url";
    if (!params.rt_token) throw "Missing rt_token";

    if (params.event_value != 1) {
        return "OK";
    }

    var base = normalizeBaseUrl(params.rt_url);

    req.addHeader("Content-Type: application/json");
    req.addHeader("Accept: application/json");
    req.addHeader("Authorization: token " + params.rt_token);

    var rawTags = getRawTags(params);
    var queue = chooseQueue(rawTags);

    var subject = trim(params.subject || params.alert_subject || "");
    var message = trim(params.message || params.alert_message || "");
    if (!subject) throw "Missing subject";
    if (!message) throw "Missing message";

    var hostGroups = trim(params.host_groups || params.groups || "");

    var ticketSql;
    var hostOnly = subject.split(" - ")[0];
    hostOnly = trim(hostOnly);

    var statusClause = "(Status = 'new' OR Status = 'open' OR Status = 'stalled')";

    if (queue === "EVENTOS") {
        if (!hostOnly) {
            throw "Cannot extract host from subject for EVENTOS. Subject=" + subject;
        }

        ticketSql =
            "Queue = '" + escSql(queue) + "'" +
            " AND " + statusClause +
            " AND Subject LIKE '" + escSql(hostOnly) + " -%'";
    } else {
        ticketSql =
            "Queue = '" + escSql(queue) + "'" +
            " AND " + statusClause +
            " AND Subject = '" + escSql(subject) + "'";
    }

    var existingId = faindOpenTicketId(base, ticketSql);

    if (existingId) {
        var replyBody =
            "Novo evento detectado:\n\n" +
            message + "\n";

        replyToTicket(base, existingId, subject, replyBody);

        return JSON.stringify({
            "tags": {
                "rt_ticket_id": String(existingId),
                "rt_queue": String(queue)
            }
        });
    }

    var createPayload = {
        "Queue": queue,
        "Subject": subject,
        "Content": message
    };

    if (queue === "PROTOCOLO") {
        var popValue = extractPopFromHostGroups(hostGroups);

        if (popValue) {
            createPayload["CustomFields"] = {
                "POP": popValue
            };
        }
    }

    Zabbix.log(4, "[ RT webhook ] create: queue=" + queue);
    Zabbix.log(4, "[ RT webhook ] create: POST " + base + "/ticket");
    Zabbix.log(4, "[ RT webhook ] create payload: " + JSON.stringify(createPayload));

    var respCreate = req.post(base + "/ticket", JSON.stringify(createPayload));
    var codeCreate = req.getStatus();

    if (!(codeCreate == 201 || httpOk(codeCreate))) {
        throw "RT create failed. HTTP " + codeCreate + " Response: " + respCreate;
    }

    var created;
    try {
        created = JSON.parse(respCreate);
    } catch (e2) {
        throw "RT create: invalid JSON response. HTTP " + codeCreate + " Response: " + respCreate;
    }

    if (!created || !created.id) {
        throw "RT create: missing ticket id in response. HTTP " + codeCreate + " Response: " + respCreate;
    }

    return JSON.stringify({
        "tags": {
            "rt_ticket_id": String(created.id),
            "rt_queue": String(queue)
        }
    });
}
catch (error) {
    Zabbix.log(3, "[ RT webhook ] ERROR: " + error);
    throw "Failed with error: " + error;
}