const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/db'); // Ajusta la ruta a tu archivo de conexión si es necesario

// --- PROCESAR INICIO DE SESIÓN (LOGIN) ---
router.post('/login', async (req, res) => {
    const { boleta, password } = req.body;

    try {
        db.query('SELECT * FROM alumno WHERE boleta = ?', [boleta], async (err, rows) => {
            if (err) {
                console.error('Error en la base de datos:', err);
                return res.render('login', { error: 'Error en la base de datos.' });
            }
            
            if (rows.length === 0) {
                return res.render('login', { error: 'Boleta no encontrada.' });
            }

            const usuario = rows[0];

            // Validación de seguridad para evitar el error de bcrypt si la contraseña está vacía o NULL
            if (!usuario.contrasena_encriptada) {
                return res.render('login', { error: 'Este usuario no tiene una contraseña registrada en el sistema.' });
            }

            // Validar la contraseña ingresada contra el hash almacenado
            const passwordMatch = await bcrypt.compare(password, usuario.contrasena_encriptada);
            
            if (!passwordMatch) {
                return res.render('login', { error: 'Contraseña incorrecta.' });
            }

            // Guardar datos en la sesión
            req.session.usuario = usuario;

            // Redirigir según el rol del usuario
            if (usuario.rol === 'admin') {
                return res.redirect('/admin');
            } else {
                // Pasar los datos del alumno por parámetros GET para que el menú los cargue dinámicamente
                const queryParams = new URLSearchParams({
                    boleta: usuario.boleta,
                    nombre: usuario.nombre,
                    adeudo: 'Sin adeudos ni sanciones pendientes. ¡Todo en orden!'
                }).toString();
                
                return res.redirect(`/menu?${queryParams}`);
            }
        });

    } catch (err) {
        console.error('Error interno:', err);
        res.status(500).send('Error interno en el servidor.');
    }
});

// --- PROCESAR REGISTRO DE ALUMNOS ---
router.post('/register', async (req, res) => {
    let { boleta, nombre, sexo, unidad_procedencia, email_institucional, password } = req.body;

    // Valores por defecto de respaldo por si el formulario HTML no envía alguno de estos campos
    unidad_procedencia = unidad_procedencia || 'ESIME Zacatenco';
    email_institucional = email_institucional || `${boleta}@ipn.mx`;
    sexo = sexo || 'No especificado';

    try {
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const query = `
            INSERT INTO alumno (boleta, nombre, sexo, unidad_procedencia, email_institucional, contrasena_encriptada, rol) 
            VALUES (?, ?, ?, ?, ?, ?, 'alumno')
        `;

        db.query(query, [boleta, nombre, sexo, unidad_procedencia, email_institucional, hashedPassword], (err, result) => {
            if (err) {
                console.error('Error al registrar en BD:', err);
                return res.render('register', { error: 'Error al registrar. La boleta o el correo institucional ya están registrados.', success: null });
            }

            // Registro exitoso, redirigir al login
            return res.redirect('/login');
        });

    } catch (err) {
        console.error('Error interno al registrar:', err);
        res.status(500).send('Error interno en el servidor al registrar.');
    }
});

module.exports = router;