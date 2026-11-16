

var RTWebhook = {
    params: {},
    request: null,

    /* Recebe e valida os parametros configurados no Media Type. */
    setParams: function (params) {
        RTWebhook.params = params;

        if (!RTWebhook.params.rt_url) {
            throw 'Parametro obrigatorio ausente: rt_url';
        }

        if (!RTWebhook.params.rt_token) {
            throw 'Parametro obrigatorio ausente: rt_token';
        }

        var hostName = String(RTWebhook.params.host_name || '')
                .replace(/^\s+|\s+$/g, ''),
            eventName = String(RTWebhook.params.event_name || '')
                .replace(/^\s+|\s+$/g, '');

        /* Usa o assunto do template; na ausencia dele, reproduz HOST.NAME - EVENT.NAME. */
        RTWebhook.params.subject = String(
            RTWebhook.params.subject || RTWebhook.params.alert_subject || ''
        ).replace(/^\s+|\s+$/g, '');
        if (!RTWebhook.params.subject && hostName && eventName) {
            RTWebhook.params.subject = hostName + ' - ' + eventName;
        }

        /* Recebe a mensagem ja renderizada pelo template do Zabbix. */
        RTWebhook.params.message = String(
            RTWebhook.params.message || RTWebhook.params.alert_message || ''
        ).replace(/^\s+|\s+$/g, '');
        RTWebhook.params.host_groups =
            RTWebhook.params.host_groups || RTWebhook.params.groups || '';
        RTWebhook.params.rt_queue = RTWebhook.getQueue(RTWebhook.params);

        RTWebhook.params.rt_url = RTWebhook.params.rt_url.replace(/\/+$/, '');
    },

    /* Script antigo, com fallback para rt_queue direto. */
    //mudado pra resolver o erro do zabbix que nao estava pegando a fila correta
    getQueue: function (params) {
        var rawTags = params.event_tags || '',
            message = params.message || params.alert_message || '',
            match,
            parts,
            queues = [],
            i,
            item,
            separator,
            key,
            queue;

            if (!rawTags) {
            match = String(message).match(
                /(?:^|\n)\s*EVENT_TAGS\s*=\s*([^\r\n]+)/
            );
            if (match) {
                rawTags = match[1];
            }
        }

        parts = String(rawTags).split(',');
        for (i = 0; i < parts.length; i++) {
            item = parts[i].replace(/^\s+|\s+$/g, '');
            separator = item.indexOf(':');
            if (separator === -1) {
                separator = item.indexOf('=');
            }
            if (separator === -1) {
                continue;
            }

            key = item.substring(0, separator).replace(/^\s+|\s+$/g, '');
            if (key === 'rt_queue') {
                queue = item.substring(separator + 1)
                    .replace(/^\s+|\s+$/g, '');
                if (queue) {
                    queues.push(queue);
                }
            }
        }

        if (queues.length > 1) {
            throw 'Mais de uma tag rt_queue encontrada: ' +
                JSON.stringify(queues);
        }

        return queues.length === 1 ?
            queues[0] :
            (params.rt_queue || 'NÃO CLASSIFICADO');
    },

    /* Cria e reutiliza o cliente HTTP com os cabecalhos da API do RT. */
    getRequest: function () {
        if (RTWebhook.request === null) {
            RTWebhook.request = new HttpRequest();
            RTWebhook.request.addHeader(
                'Authorization: token ' + RTWebhook.params.rt_token
            );
            RTWebhook.request.addHeader('Content-Type: application/json');
            RTWebhook.request.addHeader('Accept: application/json');
        }

        return RTWebhook.request;
    },

    /* Executa GET, POST ou PUT na API e valida o codigo HTTP retornado. */
    requestApi: function (method, endpoint, body) {
        var request = RTWebhook.getRequest(),
            url = RTWebhook.params.rt_url + endpoint,
            response,
            status,
            parsed;

        Zabbix.log(4, '[RT Webhook] ' + method + ' ' + url);

        if (body !== null && body !== undefined) {
            Zabbix.log(4, '[RT Webhook] Payload: ' + JSON.stringify(body));
        }

        switch (method) {
            case 'GET':
                response = request.get(url);
                break;
            case 'POST':
                response = request.post(
                    url,
                    body !== null ? JSON.stringify(body) : ''
                );
                break;
            case 'PUT':
                response = request.put(
                    url,
                    body !== null ? JSON.stringify(body) : ''
                );
                break;
            default:
                throw 'Metodo HTTP nao suportado: ' + method;
        }

        status = request.getStatus();
        Zabbix.log(4, '[RT Webhook] HTTP ' + status + ': ' + response);

        if (status < 200 || status >= 300) {
            throw 'Erro na API do RT. HTTP ' + status + '. Resposta: ' + response;
        }

        if (!response) {
            return {};
        }

        try {
            parsed = JSON.parse(response);
        }
        catch (error) {
            parsed = {raw: response};
        }

        return parsed;
    },

    /* Codifica a consulta para uso seguro na URL. */
    encodeQuery: function (value) {
        return encodeURIComponent(value);
    },

    /* Escapa barras e aspas simples usadas na pesquisa do RT. */
    escapeSearchValue: function (value) {
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'");
    },

    /* Converte uma coordenada decimal para graus, minutos e segundos (DMS). */
    decimalToDms: function (decimal, isLatitude) {
        var absolute = Math.abs(decimal),
            degrees = Math.floor(absolute),
            minutesDecimal = (absolute - degrees) * 60,
            minutes = Math.floor(minutesDecimal),
            seconds = (minutesDecimal - minutes) * 60,
            direction;

        if (isLatitude) {
            direction = decimal < 0 ? 'S' : 'N';
        }
        else {
            direction = decimal < 0 ? 'W' : 'E';
        }

        return degrees + '°' +
            minutes + "'" +
            seconds.toFixed(2) + '"' +
            direction;
    },

    /*
     * Le GEO em formato decimal e gera a representacao em DMS.
     * Exemplo de entrada: -22.905611,-47.060806
     */
    normalizeCoordinates: function (geo) {
        var value,
            match,
            latitude,
            longitude;

        if (!geo) {
            return null;
        }

        value = String(geo)
            .replace(/^\s+|\s+$/g, '')
            .replace(/[()]/g, '')
            .replace(/latitude\s*=/ig, '')
            .replace(/longitude\s*=/ig, '')
            .replace(/lat\s*=/ig, '')
            .replace(/lon\s*=/ig, '');

        match = value.match(
            /(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)/
        );

        if (!match) {
            return null;
        }

        latitude = parseFloat(match[1]);
        longitude = parseFloat(match[2]);

        if (
            isNaN(latitude) ||
            isNaN(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return null;
        }

        return {
            latitude: latitude,
            longitude: longitude,
            dms:
                RTWebhook.decimalToDms(latitude, true) +
                ', ' +
                RTWebhook.decimalToDms(longitude, false)
        };
    },

    /* Gera o link do Google Maps usando as coordenadas decimais. */
    createMapsLink: function (coordinates) {
        if (coordinates === null) {
            return '';
        }

        return 'https://www.google.com/maps/search/?api=1&query=' +
            encodeURIComponent(
                coordinates.latitude.toFixed(6) +
                ',' +
                coordinates.longitude.toFixed(6)
            );
    },

    escapeHtml: function (value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /* Retorna o nome do campo que relaciona evento e ticket. */
    getCustomFieldName: function () {
        return RTWebhook.params.rt_event_cf || 'ZabbixEventID';
    },

    /* Procura ticket aberto pelo host em EVENTOS ou pelo assunto nas demais filas. */
    findTicket: function () {
        var subject = RTWebhook.getTicketSubject(),
            hostName = RTWebhook.params.host_name ||
                (subject ? subject.split(' - ')[0] : ''),
            query,
            response,
            i,
            ticket;

        if (!hostName) {
            throw 'Parametro obrigatorio ausente: host_name';
        }

        query = "Queue = '" +
            RTWebhook.escapeSearchValue(RTWebhook.params.rt_queue) +
            "' AND (Status = 'new' OR Status = 'open' OR Status = 'stalled')";

        if (RTWebhook.params.rt_queue === 'EVENTOS') {
            query += " AND Subject LIKE '" +
                RTWebhook.escapeSearchValue(hostName) + " -%'";
        }
        else {
            query += " AND Subject = '" +
                RTWebhook.escapeSearchValue(subject) + "'";
        }

        response = RTWebhook.requestApi(
            'GET',
            '/REST/2.0/tickets?query=' +
                RTWebhook.encodeQuery(query) +
                '&fields=id,Subject,Status',
            null
        );

        if (response && response.items) {
            for (i = 0; i < response.items.length; i++) {
                ticket = response.items[i];
                if (ticket.Subject && (
                    RTWebhook.params.rt_queue === 'EVENTOS' ?
                        String(ticket.Subject).indexOf(hostName + ' -') === 0 :
                        String(ticket.Subject) === subject
                )) {
                    return ticket;
                }
            }
        }

        return null;
    },

    /* Extrai POP01..POP08 a partir dos grupos do host no formato ONU_POP0x. */
    extractPopFromHostGroups: function (groupsRaw) {
        if (!groupsRaw) {
            return '';
        }

        groupsRaw = String(groupsRaw).replace(/^\s+|\s+$/g, '');
        if (!groupsRaw) {
            return '';
        }

        var groups = groupsRaw.split(/\s*,\s*|\s*\n\s*/);

        for (var i = 0; i < groups.length; i++) {
            var g = groups[i].replace(/^\s+|\s+$/g, '');
            var m = g.match(/^ONU_(POP0[1-8])$/i);
            if (m && m[1]) {
                return m[1].toUpperCase();
            }
        }

        return '';
    },

    /* Extrai o POP de params.pop (ignorando *UNKNOWN*) ou via extractPopFromHostGroups. */
    getPop: function () {
        var popParam;

        if (RTWebhook.params.pop) {
            popParam = String(RTWebhook.params.pop)
                .replace(/^\s+|\s+$/g, '')
                .toUpperCase();

            if (popParam && popParam !== '*UNKNOWN*' && popParam.indexOf('{') !== 0) {
                return popParam;
            }
        }

        return RTWebhook.extractPopFromHostGroups(RTWebhook.params.host_groups);
    },

    /* Retorna os dados operacionais da trigger, usados como causa do problema. */
    getEventReason: function () {
        var reason = String(
            RTWebhook.params.event_opdata ||
            RTWebhook.params.event_info ||
            ''
        ).replace(/^\s+|\s+$/g, '');

        if (
            reason === '*UNKNOWN*' ||
            reason.indexOf('{') === 0
        ) {
            return '';
        }

        return reason;
    },

    /* Formata a data do evento como DD/MM/AAAA para o corpo do ticket. */
    formatEventDate: function (date) {
        var value = String(date || '').replace(/^\s+|\s+$/g, ''),
            match,
            day,
            month,
            year;

        match = value.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
        if (match) {
            year = match[1];
            month = ('0' + match[2]).slice(-2);
            day = ('0' + match[3]).slice(-2);
            return day + '/' + month + '/' + year;
        }

        match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
        if (match) {
            day = ('0' + match[1]).slice(-2);
            month = ('0' + match[2]).slice(-2);
            year = match[3];
            return day + '/' + month + '/' + year;
        }

        return value;
    },

    /* Formata a linha de data do template sem alterar as demais linhas editaveis. */
    formatEventMessage: function (message) {
        var eventDate = RTWebhook.formatEventDate(
                RTWebhook.params.event_date
            ),
            eventTime = String(RTWebhook.params.event_time || '')
                .replace(/^\s+|\s+$/g, ''),
            eventReason = RTWebhook.getEventReason() ||
                'Nao informado no Zabbix';

        message = String(message || '');
        if (eventDate && eventTime) {
            message = message.replace(
                /^Problema iniciado em:[^\r\n]*/im,
                'Problema iniciado em: ' +
                    eventDate +
                    ' -  ' +
                    eventTime
            );
        }

        if (!/(?:^|\r?\n)\s*POP\s*:/im.test(message)) {
            message = message.replace(
                /^([ \t]*Problema\s*:[^\r\n]*)/im,
                '$1\nPOP: ' + (RTWebhook.getPop() || 'Nao informado')
            );
        }

        /* Acrescenta EVENT.OPDATA apos POP, sem duplicar Motivo ja escrito no template. */
        if (!/(?:^|\r?\n)\s*Motivo\s*:/im.test(message)) {
            if (/^([ \t]*POP\s*:[^\r\n]*)/im.test(message)) {
                message = message.replace(
                    /^([ \t]*POP\s*:[^\r\n]*)/im,
                    '$1\nMotivo: ' + eventReason
                );
            }
            else {
                message = message.replace(
                    /^([ \t]*Problema\s*:[^\r\n]*)/im,
                    '$1\nMotivo: ' + eventReason
                );
            }
        }

        return message;
    },

    /* Monta o texto inicial do ticket para o tecnico. */
    buildDispatch: function (mapsLink, coordinates) {
        var lines = [],
            message = RTWebhook.params.message,
            pop = RTWebhook.getPop(),
            eventDateTime = (
                (RTWebhook.params.event_date || '') +
                ' ' +
                (RTWebhook.params.event_time || '')
            ).replace(/^\s+|\s+$/g, ''),
            hostName = RTWebhook.params.host_name || 'Nao informado',
            eventName = RTWebhook.params.event_name || 'Nao informado',
            severity = RTWebhook.params.severity || 'Nao informada';

        if (message) {
            lines.push(
                RTWebhook.escapeHtml(
                    RTWebhook.formatEventMessage(message)
                )
                    .replace(/\r\n|\r|\n/g, '<br>')
            );
            lines.push('----------------------------------------');
            lines.push('LOCALIZACAO');
            lines.push('----------------------------------------');
        }
        else {
            lines.push('----------------------------------------');
            lines.push('INFORMAÇÕES DO EVENTO');
            lines.push('----------------------------------------');
            lines.push('Unidade/Host: ' + RTWebhook.escapeHtml(hostName));
            lines.push('POP: ' + RTWebhook.escapeHtml(pop || 'Nao informado'));
            lines.push('Início:  ' +
                RTWebhook.escapeHtml(eventDateTime || 'Nao informada'));
            lines.push('Problema: ' + RTWebhook.escapeHtml(eventName));
            lines.push('Motivo: ' + RTWebhook.escapeHtml(
                RTWebhook.getEventReason() || 'Nao informado no Zabbix'
            ));
            lines.push('Severidade: ' + RTWebhook.escapeHtml(severity));
            lines.push('ID Evento Zabbix: ' +
                RTWebhook.escapeHtml(RTWebhook.params.event_id || 'Nao informado'));
            lines.push('----------------------------------------');
            lines.push('LOCALIZACAO');
            lines.push('----------------------------------------');
        }

        if (coordinates && coordinates.dms) {
            lines.push('Coordenadas DMS: ' +
                RTWebhook.escapeHtml(coordinates.dms));
        }
        else {
            lines.push('Coordenadas DMS: nao informadas ou invalidas');
        }

        if (mapsLink) {
            lines.push(
                'Google Maps: <a href="' +
                RTWebhook.escapeHtml(mapsLink) +
                '" target="_blank" rel="noopener noreferrer">' +
                RTWebhook.escapeHtml(mapsLink) +
                '</a>'
            );
        }
        else {
            lines.push('Google Maps: link nao disponivel');
        }

        return lines.join('<br>');
    },

    /* Garante que o host esteja no assunto para agrupar os tickets futuros. */
    getTicketSubject: function () {
        var hostName = RTWebhook.params.host_name || 'Host desconhecido',
            subject = RTWebhook.params.subject || '',
            hostMarker = hostName + ' -';

        if (!subject) {
            subject =
                '[Zabbix][' +
                (RTWebhook.params.severity || 'Alerta') +
                '] ' +
                hostMarker + ' ' +
                (RTWebhook.params.event_name || 'Evento');
        }

        return subject;
    },

    /* Cria um ticket quando ainda nao existe ticket para o evento. */
    createTicket: function () {
        var coordinates,
            mapsLink,
            dispatch,
            subject,
            customFields = {},
            createPayload,
            response,
            ticketId;

        coordinates = RTWebhook.normalizeCoordinates(
            RTWebhook.params.latitude + ',' + RTWebhook.params.longitude
        );
        mapsLink = RTWebhook.createMapsLink(coordinates);
        dispatch = RTWebhook.buildDispatch(mapsLink, coordinates);
        subject = RTWebhook.getTicketSubject();

        if (RTWebhook.params.event_id) {
            customFields[RTWebhook.getCustomFieldName()] =
                RTWebhook.params.event_id;
        }

        if (RTWebhook.params.rt_queue === 'PROTOCOLO') {
            var popValue = RTWebhook.extractPopFromHostGroups(
                RTWebhook.params.host_groups
            );

            if (popValue) {
                customFields['POP'] = popValue;
            }
        }

        createPayload = {
            Queue: RTWebhook.params.rt_queue,
            Subject: subject,
            Content: dispatch,
            ContentType: 'text/html',
            Status: RTWebhook.params.rt_initial_status || 'new',
            CustomFields: customFields
        };

        if (RTWebhook.params.rt_requestor) {
            createPayload.Requestor = RTWebhook.params.rt_requestor;
        }

        Zabbix.log(
            4,
            '[RT Webhook] Criando ticket na fila: ' +
            RTWebhook.params.rt_queue
        );

        response = RTWebhook.requestApi(
            'POST',
            '/REST/2.0/ticket',
            createPayload
        );

        ticketId = response.id || null;

        if (
            !ticketId &&
            response._hyperlinks &&
            response._hyperlinks.length > 0 &&
            response._hyperlinks[0].ref
        ) {
            ticketId = response._hyperlinks[0].ref;
        }

        if (!ticketId) {
            throw 'O RT nao retornou o numero do ticket criado. Resposta: ' +
                JSON.stringify(response);
        }

        return {
            id: ticketId,
            ticket_id: ticketId,
            event_id: RTWebhook.params.event_id,
            queue: RTWebhook.params.rt_queue,
            maps_link: mapsLink,
            response: response
        };
    },

    /* Adiciona um comentario a um ticket existente. */
    addComment: function (ticketId, text) {
        return RTWebhook.requestApi(
            'POST',
            '/REST/2.0/ticket/' + encodeURIComponent(ticketId) + '/comment',
            {
                Content: text,
                ContentType: 'text/plain'
            }
        );
    },

    /* Adiciona ao ticket as informacoes de uma atualizacao do evento. */
    updateTicket: function (ticketId) {
        var coordinates = RTWebhook.normalizeCoordinates(
                RTWebhook.params.latitude + ',' + RTWebhook.params.longitude
            ),
            mapsLink = RTWebhook.createMapsLink(coordinates),
            comment = [],
            customFields = {},
            updatePayload = {
                Subject: RTWebhook.getTicketSubject()
            },
            popValue;

        if (RTWebhook.params.event_id) {
            customFields[RTWebhook.getCustomFieldName()] =
                RTWebhook.params.event_id;
        }

        if (RTWebhook.params.rt_queue === 'PROTOCOLO') {
            popValue = RTWebhook.extractPopFromHostGroups(
                RTWebhook.params.host_groups
            );
            if (popValue) {
                customFields['POP'] = popValue;
            }
        }

        if (RTWebhook.params.event_id || popValue) {
            updatePayload.CustomFields = customFields;
        }

        RTWebhook.requestApi(
            'PUT',
            '/REST/2.0/ticket/' + encodeURIComponent(ticketId),
            updatePayload
        );
        // finaliza aqui a parte que da pra alterar no ticket, agora vamos adicionar o comentario com as informacoes do evento
        if (RTWebhook.params.message) {
            comment.push(
                RTWebhook.formatEventMessage(RTWebhook.params.message)
            );
        }
        else {
            comment.push('Novo problema detectado no Zabbix.');
            comment.push('');
            comment.push('ID Evento Zabbix: ' +
                (RTWebhook.params.event_id || '-'));
            comment.push(
                'Inicio: ' +
                (RTWebhook.params.event_date || '') +
                ' ' +
                (RTWebhook.params.event_time || '')
            );
            comment.push('Evento: ' + (RTWebhook.params.event_name || '-'));
            comment.push('Host: ' + (RTWebhook.params.host_name || '-'));
            comment.push('Motivo: ' +
                (RTWebhook.getEventReason() || 'Nao informado no Zabbix'));
            comment.push('Severidade: ' + (RTWebhook.params.severity || '-'));
            comment.push('POP: ' + (RTWebhook.getPop() || '-'));

            if (RTWebhook.params.event_update_action) {
                comment.push('Acao: ' + RTWebhook.params.event_update_action);
            }

            if (RTWebhook.params.event_update_message) {
                comment.push('');
                comment.push('Mensagem da atualizacao:');
                comment.push(RTWebhook.params.event_update_message);
            }
        }

        if ((coordinates && coordinates.dms) || mapsLink) {
            comment.push('----------------------------------------');
            comment.push('LOCALIZACAO');
            comment.push('----------------------------------------');

            if (coordinates && coordinates.dms) {
                comment.push('Coordenadas DMS: ' + coordinates.dms);
            }

            if (mapsLink) {
                comment.push('Google Maps: ' + mapsLink);
            }
        }

        return RTWebhook.addComment(ticketId, comment.join('\n'));
    },

    /* Registra a recuperacao sem fechar o ticket compartilhado. */
    commentRecovery: function (ticketId) {
        var comment = [];

        if (RTWebhook.params.message) {
            comment.push(
                RTWebhook.formatEventMessage(RTWebhook.params.message)
            );
        }
        else {
            comment.push('Problema normalizado no Zabbix.');
            comment.push('');
            comment.push('ID Evento Zabbix: ' +
                (RTWebhook.params.event_id || '-'));
            comment.push('Evento: ' + (RTWebhook.params.event_name || '-'));
            comment.push('Host: ' + (RTWebhook.params.host_name || '-'));
            comment.push('Motivo: ' +
                (RTWebhook.getEventReason() || 'Nao informado no Zabbix'));
            comment.push(
                'Data/hora de recuperacao: ' +
                (RTWebhook.params.event_recovery_date || '') +
                ' ' +
                (RTWebhook.params.event_recovery_time || '')
            );
            if (RTWebhook.params.event_duration) {
                comment.push('Duracao: ' + RTWebhook.params.event_duration);
            }
        }

        return RTWebhook.addComment(ticketId, comment.join('\n'));
    }
};

try {
    var params = JSON.parse(value),
        ticket,
        result;

    RTWebhook.setParams(params);

    if (params.event_value === undefined || params.event_value === null) {
        throw 'Parametro obrigatorio ausente: event_value';
    }

    /* Valida o assunto do template (ou fallback) e a mensagem antes da criacao. */
    if (String(params.event_value) === '1') {
        if (!RTWebhook.params.subject) {
            throw 'Parametro obrigatorio ausente: subject';
        }
        if (!RTWebhook.params.message) {
            throw 'Parametro obrigatorio ausente: message';
        }
    }

    ticket = RTWebhook.findTicket();

    if (String(params.event_value) === '1') {
        if (ticket !== null) {
            RTWebhook.updateTicket(ticket.id);
            result = {
                status: 'updated',
                ticket_id: ticket.id,
                event_id: params.event_id
            };
        }
        else {
            result = RTWebhook.createTicket();
            result.status = 'created';
            result.event_id = params.event_id;
        }
    }
    else if (String(params.event_value) === '0') {
        if (ticket === null) {
            throw 'Nao foi encontrado chamado aberto para registrar a recuperacao.';
        }

        RTWebhook.commentRecovery(ticket.id);
        result = {
            status: 'recovery_noted',
            ticket_id: ticket.id,
            event_id: params.event_id
        };
    }
    else {
        throw 'Valor de evento desconhecido: ' + params.event_value;
    }

    Zabbix.log(
        3,
        '[RT Webhook] Processamento concluido: ' + JSON.stringify(result)
    );

    return JSON.stringify(result);
}
catch (error) {
    Zabbix.log(3, '[RT Webhook] Falha: ' + error);
    throw 'Falha no webhook do RT: ' + error;
}