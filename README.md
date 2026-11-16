# Integracao Zabbix e Request Tracker

Webhook em JavaScript para criar e atualizar tickets do Request Tracker (RT) a partir de eventos do Zabbix, usando a API REST 2.0 do RT.

## Recursos

- Cria tickets para novos problemas e atualiza tickets ativos correspondentes.
- Usa o assunto e a mensagem dos templates do Zabbix; se o assunto nao for enviado, usa `HOST.NAME - EVENT.NAME`.
- Registra atualizacoes e recuperacoes como novos comentarios. Comentarios anteriores sao preservados, e a recuperacao nao fecha o ticket automaticamente.
- Inclui o POP extraido dos grupos de host `ONU_POP01` a `ONU_POP08`.
- Exibe o motivo do problema usando os dados operacionais da trigger (`{EVENT.OPDATA}`), com `event_info` como alternativa.
- Inclui coordenadas em DMS e link do Google Maps quando latitude e longitude estao configuradas.

## Requisitos

- Zabbix com suporte a Media types do tipo Webhook.
- Request Tracker com a API REST 2.0 habilitada e um token de API.
- Campos personalizados no RT para o ID do evento (`ZabbixEventID`, por padrao) e, quando usada a fila `PROTOCOLO`, para o POP.

## Configuracao

1. No Zabbix, crie ou edite um Media type do tipo Webhook e use o conteudo de [`script.js`](./script.js) como script.
2. Cadastre os parametros do Media type conforme [`Parameters.txt`](./Parameters.txt). Substitua os exemplos pelos valores do seu ambiente diretamente na configuracao do Zabbix.
3. Configure os templates Problem, Update e Recovery. O webhook aceita `subject`/`message` e os aliases `alert_subject`/`alert_message`.
4. Envie `event_tags` para que a tag `rt_queue` selecione a fila do RT. Se nao houver essa tag, `rt_queue` e usado como alternativa.
5. Envie `host_groups = {TRIGGER.HOSTGROUP.NAME}` para identificar o POP. Configure tambem `event_opdata = {EVENT.OPDATA}` para incluir o motivo real do evento.
6. Configure latitude e longitude no inventario do host para incluir a localizacao no ticket.

Consulte [`Parameters.txt`](./Parameters.txt) para a lista completa dos parametros e dos macros do Zabbix.

## Seguranca

Os valores de exemplo nos arquivos nao sao credenciais de producao. Configure o endereco do RT, o token e os dados especificos da sua infraestrutura no Zabbix. Nunca publique tokens, senhas, enderecos internos ou dados reais de eventos.

## Autor

Thomas Henrique Ferreira
