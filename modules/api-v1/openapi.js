// Especificación OpenAPI de la API pública v1. Vive junto a routes.js a
// propósito: si tocas una ruta, tienes la spec delante. Servida en
// GET /api/v1/openapi.json y renderizada en /api/docs.

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'validation' },
        message: { type: 'string', example: 'to es requerido' },
      },
    },
  },
};

const err = (description) => ({
  description,
  content: { 'application/json': { schema: ERROR_SCHEMA } },
});

const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'AiChat API',
    version: '1.1.0',
    description: [
      'API de la plataforma de chatbots de WhatsApp de Xpandex.',
      '',
      'Cada **API key** pertenece a un cliente y accede únicamente a sus datos.',
      'La key se genera desde el panel de administración (ficha del cliente → Integración) y se muestra una sola vez.',
      '',
      '**Autenticación**: cabecera `Authorization: Bearer xpk_…` (o `X-Api-Key`).',
      '',
      '**Límites**: 120 peticiones/minuto por key · archivos hasta 16MB · las conversaciones son un buffer reciente en memoria, no un histórico persistente.',
      '',
      '## Webhooks de eventos',
      '',
      'Configura una URL (aquí vía `PUT /events-webhook`, o en el panel → Ajustes → API) y recibirás un POST por cada evento:',
      '`message.received` · `message.sent` · `message.delivered` · `message.read` · `handoff.started` · `handoff.resumed` · `session.connected` · `session.disconnected`.',
      '',
      'Cada entrega incluye `X-AiChat-Event` (tipo), `X-AiChat-Delivery` (id único) y `X-AiChat-Signature: sha256=<hex>` — HMAC-SHA256 del body con tu secret `whsec_…`. Verifícala siempre. Reintentos: 30s, 2min y 10min si tu endpoint no responde 2xx.',
      '',
      '## Idempotencia',
      '',
      'En `POST /messages` puedes enviar la cabecera `Idempotency-Key` (cualquier string único, máx. 128): los reintentos con la misma clave devuelven la respuesta original SIN reenviar el WhatsApp (ventana de 24h).',
    ].join('\n'),
  },
  servers: [{ url: 'https://aichat.xpandex.es/api/v1' }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'xpk_…',
        description: 'API key del cliente. También se acepta la cabecera X-Api-Key.',
      },
    },
    schemas: {
      Error: ERROR_SCHEMA,
      Message: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['in', 'out'] },
          id: { type: 'string', nullable: true },
          body: { type: 'string' },
          senderName: { type: 'string', nullable: true, description: 'En grupos, quién habló' },
          hasMedia: { type: 'boolean' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      Handoff: {
        type: 'object',
        properties: {
          clientId: { type: 'integer' },
          contactJid: { type: 'string', example: '34600111222@s.whatsapp.net' },
          motivo: { type: 'string', nullable: true },
          resumen: { type: 'string', nullable: true },
          assignedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
  },
  paths: {
    '/me': {
      get: {
        summary: 'Identidad y estado de la conexión WhatsApp',
        tags: ['Cuenta'],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                example: {
                  client: { id: 4, name: 'Mi Negocio' },
                  whatsapp: { connected: true, status: 'ready', number: '34612413958' },
                },
              },
            },
          },
          401: err('API key ausente o inválida'),
        },
      },
    },
    '/messages': {
      post: {
        summary: 'Enviar (o iniciar) una conversación',
        description: 'Envía texto o un archivo a un número. Puede INICIAR conversaciones (no hace falta que el contacto haya escrito antes). Las menciones `@34600111222` en el texto se convierten en menciones reales de WhatsApp.',
        tags: ['Mensajes'],
        parameters: [{
          name: 'Idempotency-Key', in: 'header', required: false,
          schema: { type: 'string', maxLength: 128 },
          description: 'Los reintentos con la misma clave no reenvían el mensaje (24h)',
        }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              examples: {
                texto: {
                  summary: 'Mensaje de texto',
                  value: { to: '34600111222', text: 'Hola, te escribimos por tu contrato PPL-2026-0042.' },
                },
                archivoPorUrl: {
                  summary: 'Archivo desde URL (PDF, imagen…)',
                  value: { to: '34600111222', file: { url: 'https://midominio.es/borrador.pdf', fileName: 'Borrador.pdf', caption: 'Tu borrador' } },
                },
                archivoBase64: {
                  summary: 'Archivo en base64',
                  value: { to: '34600111222', file: { dataBase64: 'JVBERi0…', mimetype: 'application/pdf', fileName: 'Factura.pdf' } },
                },
              },
              schema: {
                type: 'object',
                required: ['to'],
                properties: {
                  to: { type: 'string', description: 'Número internacional (34600111222) o JID' },
                  text: { type: 'string' },
                  file: {
                    type: 'object',
                    properties: {
                      url: { type: 'string', description: 'La app descarga y valida el tipo real (PDF, imagen, Office, CSV, ZIP)' },
                      dataBase64: { type: 'string' },
                      mimetype: { type: 'string' },
                      fileName: { type: 'string' },
                      caption: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Enviado',
            content: { 'application/json': { example: { id: '3EB0…', to: '34600111222@s.whatsapp.net', timestamp: '2026-09-01T10:00:00.000Z' } } },
          },
          400: err('Datos inválidos (o la URL no es un archivo permitido)'),
          401: err('API key ausente o inválida'),
          409: err('La sesión de WhatsApp del cliente no está conectada'),
          429: err('Límite de peticiones alcanzado'),
        },
      },
    },
    '/messages/{id}/status': {
      get: {
        summary: 'Estado de entrega de un mensaje enviado',
        description: 'Ticks de WhatsApp: sent → delivered → read. Buffer en memoria (mensajes recientes).',
        tags: ['Mensajes'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { example: { id: '3EB0…', status: 'read', to: '34600111222@s.whatsapp.net', updatedAt: '2026-09-01T10:05:00.000Z' } } },
          },
          404: err('Sin estado para ese id (o expiró del buffer)'),
          401: err('API key ausente o inválida'),
        },
      },
    },
    '/events-webhook': {
      get: {
        summary: 'Configuración del webhook de eventos',
        tags: ['Eventos'],
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { example: { url: 'https://midominio.es/aichat-events', secret: 'whsec_…' } } },
          },
          401: err('API key ausente o inválida'),
        },
      },
      put: {
        summary: 'Configurar el webhook de eventos',
        description: 'URL vacía desactiva los eventos. `regenerateSecret: true` rota el secret de firma.',
        tags: ['Eventos'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { url: 'https://midominio.es/aichat-events' },
              schema: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  regenerateSecret: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'OK', content: { 'application/json': { example: { url: 'https://midominio.es/aichat-events', secret: 'whsec_…' } } } },
          400: err('URL inválida'),
          401: err('API key ausente o inválida'),
        },
      },
    },
    '/conversations': {
      get: {
        summary: 'Conversaciones recientes',
        description: 'Buffer reciente en memoria (últimos ~50 mensajes por conversación). NO es un histórico persistente: un reinicio del servicio lo vacía.',
        tags: ['Conversaciones'],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                example: {
                  conversations: [
                    { contactJid: '34600111222@s.whatsapp.net', name: 'Ana', isGroup: false, lastAt: '2026-09-01T09:58:00.000Z', lastMessage: 'Gracias!' },
                  ],
                },
              },
            },
          },
          401: err('API key ausente o inválida'),
        },
      },
    },
    '/conversations/{jid}/messages': {
      get: {
        summary: 'Hilo reciente con un contacto',
        tags: ['Conversaciones'],
        parameters: [{
          name: 'jid', in: 'path', required: true,
          schema: { type: 'string' },
          description: 'Número (34600111222) o JID del contacto/grupo',
        }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    contactJid: { type: 'string' },
                    name: { type: 'string', nullable: true },
                    isGroup: { type: 'boolean' },
                    messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                  },
                },
              },
            },
          },
          404: err('Sin conversación reciente con ese contacto'),
          401: err('API key ausente o inválida'),
        },
      },
    },
    '/contacts/{jid}': {
      get: {
        summary: 'Perfil de un contacto',
        description: 'Foto, "info" y perfil de empresa (si es cuenta Business). Campos null si la privacidad del contacto los oculta.',
        tags: ['Contactos'],
        parameters: [{ name: 'jid', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                example: {
                  profile: {
                    jid: '34600111222@s.whatsapp.net', phone: '34600111222', isGroup: false,
                    pictureUrl: 'https://pps.whatsapp.net/…', about: 'Disponible',
                    business: { description: 'Taller mecánico', category: 'Automotive', email: 'info@taller.es', website: ['https://taller.es'], address: 'Calle Mayor 1' },
                  },
                },
              },
            },
          },
          401: err('API key ausente o inválida'),
          409: err('Sin sesión conectada para consultar'),
        },
      },
    },
    '/handoff': {
      get: {
        summary: 'Contactos en atención humana',
        tags: ['Handoff'],
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { handoffs: { type: 'array', items: { $ref: '#/components/schemas/Handoff' } } } } } },
          },
          401: err('API key ausente o inválida'),
        },
      },
      post: {
        summary: 'Iniciar handoff (pausar el bot para un contacto)',
        description: 'El bot deja de responder a ese contacto hasta que se devuelva con /handoff/resume (o desde el panel).',
        tags: ['Handoff'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { contactJid: '34600111222', motivo: 'venta_compleja', resumen: 'Quiere un presupuesto a medida' },
              schema: {
                type: 'object', required: ['contactJid'],
                properties: {
                  contactJid: { type: 'string' },
                  motivo: { type: 'string' },
                  resumen: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Handoff iniciado', content: { 'application/json': { example: { ok: true, contactJid: '34600111222@s.whatsapp.net' } } } },
          400: err('contactJid inválido'),
          401: err('API key ausente o inválida'),
        },
      },
    },
    '/handoff/resume': {
      post: {
        summary: 'Devolver un contacto al bot',
        tags: ['Handoff'],
        requestBody: {
          required: true,
          content: { 'application/json': { example: { contactJid: '34600111222' }, schema: { type: 'object', required: ['contactJid'], properties: { contactJid: { type: 'string' } } } } },
        },
        responses: {
          200: { description: 'OK', content: { 'application/json': { example: { ok: true } } } },
          401: err('API key ausente o inválida'),
        },
      },
    },
    '/groups': {
      post: {
        summary: 'Crear un grupo de WhatsApp',
        tags: ['Grupos'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { subject: 'Soporte · Proyecto X', participants: ['34600111222', '34600333444'] },
              schema: {
                type: 'object', required: ['subject', 'participants'],
                properties: {
                  subject: { type: 'string' },
                  participants: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Creado', content: { 'application/json': { example: { id: '120363…@g.us', subject: 'Soporte · Proyecto X', participants: 2 } } } },
          400: err('subject y participantes requeridos'),
          401: err('API key ausente o inválida'),
          409: err('Sesión no conectada'),
        },
      },
    },
    '/groups/join': {
      post: {
        summary: 'Unirse a un grupo por invitación',
        tags: ['Grupos'],
        requestBody: {
          required: true,
          content: { 'application/json': { example: { invite: 'https://chat.whatsapp.com/AbCdEf123' }, schema: { type: 'object', required: ['invite'], properties: { invite: { type: 'string', description: 'Enlace completo o código' } } } } },
        },
        responses: {
          200: { description: 'OK', content: { 'application/json': { example: { id: '120363…@g.us' } } } },
          401: err('API key ausente o inválida'),
          409: err('Sesión no conectada'),
        },
      },
    },
    '/stats/daily': {
      get: {
        summary: 'Mensajes por día (contadores)',
        tags: ['Stats'],
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 14, maximum: 90 } }],
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { example: { days: [{ day: '2026-09-01', in: 42, out: 40 }] } } },
          },
          401: err('API key ausente o inválida'),
        },
      },
    },
  },
};

module.exports = { openapiSpec };
