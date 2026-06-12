import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

export const connectDB = async () => {
  try {
    // Configurar mongoose para que no espere infinitamente si no hay conexión
    // bufferCommands: false hace que las operaciones fallen inmediatamente si no hay conexión
    mongoose.set('bufferCommands', false);
    
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000, // Tiempo de espera para seleccionar el servidor (5s)
    });
    console.log('✅ MongoDB conectado');
  } catch (error) {
    console.error('❌ Error al conectar a MongoDB:', error.message);
    console.log('⚠️ Continuando sin conexión a MongoDB. Las operaciones de BD fallarán inmediatamente.');
  }
};

export const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
};
