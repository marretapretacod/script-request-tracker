/*
 * Zabbix -> Request Tracker (RT) Webhook
 *
 * Fluxo:
 * - EVENT.VALUE = 1: procura o ticket e cria ou atualiza.
 * - EVENT.VALUE = 0: comenta e resolve o ticket existente.
 *
 * Requisitos:
 * - API REST 2.0 do RT habilitada.
 * - Token com permissao para pesquisar, criar, comentar e alterar tickets.
 * - Campo personalizado ZabbixEventID aplicado a fila do RT.
 *
 * Observacao:
 * - O filtro para enviar somente eventos Disaster deve ser configurado
 *   na Action do Zabbix: Trigger severity equals Disaster.
 */

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

        if (!RTWebhook.params.rt_queue) {
            throw 'Parametro obrigatorio ausente: rt_queue';
        }

        RTWebhook.params.rt_url = RTWebhook.params.rt_url.replace(/\/+$/, '');
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

    /* Retorna o nome do campo que relaciona evento e ticket. */
    getCustomFieldName: function () {
        return RTWebhook.params.rt_event_cf || 'ZabbixEventID';
    },

    /* Procura um ticket na fila pelo Event ID do Zabbix. */
    findTicket: function () {
        var eventId = RTWebhook.params.event_id,
            fieldName = RTWebhook.getCustomFieldName(),
            query,
            response;

        query =
            "Queue = '" +
            RTWebhook.escapeSearchValue(RTWebhook.params.rt_queue) +
            "' AND CF.{" +
            fieldName +
            "} = '" +
            RTWebhook.escapeSearchValue(eventId) +
            "'";

        response = RTWebhook.requestApi(
            'GET',
            '/REST/2.0/tickets?query=' +
                RTWebhook.encodeQuery(query) +
                '&fields=id,Subject,Status',
            null
        );

        if (response && response.items && response.items.length > 0) {
            return response.items[0];
        }

        return null;
    },

    /* Monta o texto inicial do ticket para o tecnico. */
    buildDispatch: function (mapsLink, coordinates) {
        var lines = [];

        lines.push('ACIONAMENTO TECNICO');
        lines.push('========================================');
        lines.push('');
        lines.push('Unidade/Host: ' +
            (RTWebhook.params.host_name || 'Nao informado'));
        lines.push('IP monitorado: ' +
            (RTWebhook.params.host_ip || 'Nao informado'));
        lines.push('Problema: ' +
            (RTWebhook.params.event_name || 'Nao informado'));
        lines.push('Severidade: ' +
            (RTWebhook.params.severity || 'Nao informada'));
        lines.push('POP: ' +
            (RTWebhook.params.pop || 'Nao informado'));
        lines.push('');

        lines.push('LOCALIZACAO');
        lines.push('----------------------------------------');

        if (coordinates && coordinates.dms) {
            lines.push('Coordenadas DMS: ' + coordinates.dms);
        }
        else {
            lines.push('Coordenadas DMS: nao informadas ou invalidas');
        }

        if (mapsLink) {
            lines.push('Google Maps: ' + mapsLink);
        }
        else {
            lines.push('Google Maps: link nao disponivel');
        }

        lines.push('');
        lines.push('INFORMACOES DO EVENTO');
        lines.push('----------------------------------------');
        lines.push('Event ID: ' +
            (RTWebhook.params.event_id || 'Nao informado'));
        lines.push('Trigger ID: ' +
            (RTWebhook.params.trigger_id || 'Nao informado'));
        lines.push(
            'Data/hora: ' +
            (RTWebhook.params.event_date || 'Data nao informada') +
            ' ' +
            (RTWebhook.params.event_time || '')
        );

        if (RTWebhook.params.event_url) {
            lines.push('Evento no Zabbix: ' + RTWebhook.params.event_url);
        }

        if (RTWebhook.params.message) {
            lines.push('');
            lines.push('ORIENTACOES PARA O TECNICO');
            lines.push('----------------------------------------');
            lines.push(RTWebhook.params.message);
        }

        if (RTWebhook.params.event_opdata) {
            lines.push('');
            lines.push('DADOS OPERACIONAIS');
            lines.push('----------------------------------------');
            lines.push(RTWebhook.params.event_opdata);
        }

        lines.push('');
        lines.push('Apos o atendimento, informar:');
        lines.push('- Causa do problema;');
        lines.push('- Procedimento realizado;');
        lines.push('- Resultado dos testes;');
        lines.push('- Horario da normalizacao;');
        lines.push('- Responsavel pelo atendimento.');

        return lines.join('\n');
    },

    /* Cria um ticket quando ainda nao existe ticket para o evento. */
    createTicket: function () {
        var coordinates,
            mapsLink,
            dispatch,
            subject,
            customFields = {},
            payload,
            response,
            ticketId;

        coordinates = RTWebhook.normalizeCoordinates(RTWebhook.params.geo);
        mapsLink = RTWebhook.createMapsLink(coordinates);
        dispatch = RTWebhook.buildDispatch(mapsLink, coordinates);

        subject = RTWebhook.params.subject;

        if (!subject) {
            subject =
                '[Zabbix][' +
                (RTWebhook.params.severity || 'Alerta') +
                '] ' +
                (RTWebhook.params.host_name || 'Host desconhecido') +
                ' - ' +
                (RTWebhook.params.event_name || 'Evento');
        }

        customFields[RTWebhook.getCustomFieldName()] =
            RTWebhook.params.event_id;

        if (RTWebhook.params.rt_pop_cf && RTWebhook.params.pop) {
            customFields[RTWebhook.params.rt_pop_cf] =
                RTWebhook.params.pop;
        }

        if (RTWebhook.params.rt_geo_cf && RTWebhook.params.geo) {
            customFields[RTWebhook.params.rt_geo_cf] =
                RTWebhook.params.geo;
        }

        payload = {
            Queue: RTWebhook.params.rt_queue,
            Subject: subject,
            Content: dispatch,
            ContentType: 'text/plain',
            Status: RTWebhook.params.rt_initial_status || 'new',
            CustomFields: customFields
        };

        if (RTWebhook.params.rt_requestor) {
            payload.Requestor = RTWebhook.params.rt_requestor;
        }

        Zabbix.log(
            4,
            '[RT Webhook] Criando ticket na fila: ' +
            RTWebhook.params.rt_queue
        );

        response = RTWebhook.requestApi(
            'POST',
            '/REST/2.0/ticket',
            payload
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
        var coordinates = RTWebhook.normalizeCoordinates(RTWebhook.params.geo),
            mapsLink = RTWebhook.createMapsLink(coordinates),
            comment = [];

        comment.push('Atualizacao recebida do Zabbix.');
        comment.push('');
        comment.push('Evento: ' + (RTWebhook.params.event_name || '-'));
        comment.push('Host: ' + (RTWebhook.params.host_name || '-'));
        comment.push('Severidade: ' + (RTWebhook.params.severity || '-'));
        comment.push('POP: ' + (RTWebhook.params.pop || '-'));

        if (coordinates && coordinates.dms) {
            comment.push('Coordenadas DMS: ' + coordinates.dms);
        }

        if (mapsLink) {
            comment.push('Google Maps: ' + mapsLink);
        }

        if (RTWebhook.params.event_update_action) {
            comment.push('Acao: ' + RTWebhook.params.event_update_action);
        }

        if (RTWebhook.params.event_update_message) {
            comment.push('');
            comment.push('Mensagem da atualizacao:');
            comment.push(RTWebhook.params.event_update_message);
        }

        if (RTWebhook.params.message) {
            comment.push('');
            comment.push('Mensagem automatica do Zabbix:');
            comment.push(RTWebhook.params.message);
        }

        if (RTWebhook.params.event_opdata) {
            comment.push('');
            comment.push('Dados operacionais: ' + RTWebhook.params.event_opdata);
        }

        return RTWebhook.addComment(ticketId, comment.join('\n'));
    },

    /* Comenta a recuperacao e muda o status do ticket para resolved. */
    resolveTicket: function (ticketId) {
        var comment = [],
            finalStatus = RTWebhook.params.rt_resolved_status || 'resolved';

        comment.push('Evento encerrado no Zabbix.');
        comment.push('');
        comment.push('Evento: ' + (RTWebhook.params.event_name || '-'));
        comment.push('Host: ' + (RTWebhook.params.host_name || '-'));
        comment.push(
            'Data/hora de recuperacao: ' +
            (RTWebhook.params.event_recovery_date || '') +
            ' ' +
            (RTWebhook.params.event_recovery_time || '')
        );
        comment.push('Event ID: ' + RTWebhook.params.event_id);

        if (RTWebhook.params.event_duration) {
            comment.push('Duracao: ' + RTWebhook.params.event_duration);
        }

        if (RTWebhook.params.message) {
            comment.push('');
            comment.push('Mensagem de recuperacao:');
            comment.push(RTWebhook.params.message);
        }

        RTWebhook.addComment(ticketId, comment.join('\n'));

        return RTWebhook.requestApi(
            'PUT',
            '/REST/2.0/ticket/' + encodeURIComponent(ticketId),
            {Status: finalStatus}
        );
    }
};

try {
    var params = JSON.parse(value),
        ticket,
        result;

    RTWebhook.setParams(params);

    if (!params.event_id) {
        throw 'Parametro obrigatorio ausente: event_id';
    }

    if (params.event_value === undefined || params.event_value === null) {
        throw 'Parametro obrigatorio ausente: event_value';
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
            throw 'Nao foi encontrado ticket para resolver. Event ID: ' +
                params.event_id;
        }

        RTWebhook.resolveTicket(ticket.id);
        result = {
            status: 'resolved',
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
