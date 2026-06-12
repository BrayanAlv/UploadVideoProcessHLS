export const errorHandler = (err, req, res, next) => {
  console.error('[Error Handler]', err.stack);

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Error interno del servidor';

  // Manejar errores de conexión de Mongoose/MongoDB
  if (err.name === 'MongooseError' || err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError') {
    statusCode = 503; // Service Unavailable
    message = 'Error de conexión con la base de datos. Por favor, verifique la configuración de red y la whitelist de IP en MongoDB Atlas.';
  }

  res.status(statusCode).json({
    success: false,
    error: message
  });
};
