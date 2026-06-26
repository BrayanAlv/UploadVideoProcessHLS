// services/videoProcessing.service.js

import Contenido from '../models/Contenido.js';

export async function updateVideoProcessing(
    contenidoId,
    updates
) {
    const setData = {};

    Object.entries(updates).forEach(
        ([key, value]) => {
            setData[`videoProcessing.${key}`] = value;
        }
    );

    return Contenido.updateOne(
        { _id: contenidoId },
        {
            $set: setData
        }
    );
}