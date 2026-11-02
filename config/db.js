require('dotenv').config(); // <-- Agrega esta línea al inicio
const mysql = require('mysql2');

// Creamos la conexión usando estrictamente las variables del archivo .env
const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

connection.connect((err) => {
    if (err) {
        console.error('Error de conexión a la base de datos local:', err);
        return;
    }
    console.log('¡Conectado exitosamente a la base de datos local en el puerto 3307!');
});

module.exports = connection;