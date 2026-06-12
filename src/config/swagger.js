import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Video Processor API',
      version: '1.0.0',
      description: 'API para procesamiento de video asíncrono',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Servidor de desarrollo',
      },
    ],
    components: {
      schemas: {
        Video: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            originalFileName: { type: 'string' },
            originalSize: { type: 'number' },
            duration: { type: 'number' },
            status: { 
              type: 'string', 
              enum: ['uploaded', 'processing', 'completed', 'failed'] 
            },
            progress: { type: 'number' },
            thumbnailPath: { type: 'string' },
            previewVttPath: { type: 'string' },
            hlsMasterPath: { type: 'string' },
            availableQualities: { 
              type: 'array',
              items: { type: 'string' }
            },
            originalResolution: { type: 'string' },
            errorMessage: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
  },
  apis: ['./src/routes/*.js'], // Ruta a los archivos con anotaciones
};

export const swaggerSpec = swaggerJsdoc(options);
