require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./config/db'); // Conexión a la base de datos MariaDB

const app = express();

// --- 1. MIDDLEWARES Y CONFIGURACIÓN ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'secreto_biblioteca_ipn',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// --- 2. AUTO-RECREACIÓN DE EMERGENCIA DEL ADMINISTRADOR ---
db.query("DELETE FROM alumno WHERE boleta = 'ADMIN001'", async (err) => {
    try {
        const hashedPassword = await bcrypt.hash('123456789', 10);
        const queryAdmin = `
            INSERT INTO alumno (boleta, nombre, sexo, unidad_procedencia, email_institucional, contrasena_encriptada, rol) 
            VALUES ('ADMIN001', 'Administrador General', 'No especificado', 'ESIME Zacatenco', NULL, ?, 'admin')
        `;
        db.query(queryAdmin, [hashedPassword], (errInsert) => {
            if (errInsert) {
                console.error('Error al insertar el Administrador:', errInsert.message);
            } else {
                console.log('✔ Administrador (ADMIN001 / 123456789) verificado y listo en la base de datos.');
            }
        });
    } catch (e) {
        console.error('Error al generar el hash para el Administrador:', e);
    }
});

// --- 3. RUTAS DE NAVEGACIÓN (GET) ---
app.get('/', (req, res) => { res.redirect('/login'); });
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'login.html')); });
app.get('/register', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'register.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'admin.html')); });
app.get('/catalogo', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'catalogo.html')); });
app.get('/datos', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'datos.html')); });
app.get('/forgot', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'forgot.html')); });
app.get('/historial', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'historial.html')); });
app.get('/menu', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'menu.html')); });
app.get('/prestamo', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'prestamo.html')); });

// --- 4. RUTAS API ---
app.get('/api/libros', (req, res) => {
    const busqueda = req.query.q || '';
    const searchTerm = `%${busqueda}%`;
    const query = 'SELECT * FROM libro WHERE titulo LIKE ? OR autor LIKE ? OR isbn LIKE ?';

    db.query(query, [searchTerm, searchTerm, searchTerm], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error al obtener los libros.' });
        res.json(results);
    });
});

app.post('/api/prestamo/solicitar', (req, res) => {
    const { boleta, id_libro } = req.body;
    if (!boleta || !id_libro) return res.json({ success: false, message: 'Datos incompletos.' });

    const queryVerificarDuplicado = "SELECT * FROM prestamo WHERE boleta = ? AND id_libro = ? AND estatus != 'devuelto' AND estatus != 'entregado'";

    db.query(queryVerificarDuplicado, [boleta, id_libro], (errDup, duplicados) => {
        if (errDup || duplicados.length > 0) {
            return res.json({ success: false, message: 'Ya tienes un préstamo activo de este libro.' });
        }

        db.query('SELECT * FROM libro WHERE id_libro = ?', [id_libro], (err, libros) => {
            if (err || libros.length === 0 || libros[0].disponibles <= 0) {
                return res.json({ success: false, message: 'Libro no disponible o agotado.' });
            }

            db.beginTransaction(errTrans => {
                if (errTrans) return res.json({ success: false, message: 'Error interno.' });

                const queryPrestamo = "INSERT INTO prestamo (boleta, id_libro, fecha_prestamo, fecha_devolucion, estatus, sancion) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 'activo', 'Ninguna')";

                db.query(queryPrestamo, [boleta, id_libro], (errP) => {
                    if (errP) return db.rollback(() => res.json({ success: false, message: 'Error al registrar préstamo.' }));

                    db.query('UPDATE libro SET disponibles = disponibles - 1 WHERE id_libro = ?', [id_libro], (errU) => {
                        if (errU) return db.rollback(() => res.json({ success: false, message: 'Error al actualizar inventario.' }));

                        db.commit(errC => {
                            if (errC) return db.rollback(() => res.json({ success: false, message: 'Error al confirmar.' }));
                            res.json({ success: true, message: '¡Préstamo solicitado con éxito por 30 días!' });
                        });
                    });
                });
            });
        });
    });
});

app.get('/api/prestamos/:boleta', (req, res) => {
    const query = "SELECT p.*, l.titulo, l.autor FROM prestamo p JOIN libro l ON p.id_libro = l.id_libro WHERE p.boleta = ? AND p.estatus != 'devuelto' AND p.estatus != 'entregado'";
    db.query(query, [req.params.boleta], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error al obtener préstamos.' });
        res.json(results);
    });
});

app.get('/api/historial/:boleta', (req, res) => {
    const query = "SELECT p.*, l.titulo, l.autor FROM prestamo p JOIN libro l ON p.id_libro = l.id_libro WHERE p.boleta = ? AND (p.estatus = 'devuelto' OR p.estatus = 'entregado')";
    db.query(query, [req.params.boleta], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error al obtener historial.' });
        res.json(results);
    });
});

app.get('/api/alumno/historial-fechas', (req, res) => {
    const { boleta, inicio, fin } = req.query;
    const query = "SELECT p.*, l.titulo, l.autor FROM prestamo p JOIN libro l ON p.id_libro = l.id_libro WHERE p.boleta = ? AND p.fecha_prestamo BETWEEN ? AND ?";
    db.query(query, [boleta, `${inicio} 00:00:00`, `${fin} 23:59:59`], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error al consultar.' });
        res.json(results);
    });
});

app.get('/api/alumno/carta-no-adeudo', (req, res) => {
    const boleta = req.query.boleta;
    const queryCheck = "SELECT * FROM prestamo WHERE boleta = ? AND (estatus = 'activo' OR estatus = 'retrasado' OR sancion = 'Castigo' OR sancion = 'Multa')";
    
    db.query(queryCheck, [boleta], (err, adeudos) => {
        if (err || adeudos.length > 0) {
            return res.json({ success: false, message: 'No eres elegible para la Carta de No Adeudo debido a préstamos pendientes o sanciones.' });
        }

        db.query("SELECT * FROM alumno WHERE boleta = ?", [boleta], (errAlu, alumnos) => {
            if (errAlu || alumnos.length === 0) return res.json({ success: false, message: 'Alumno no encontrado.' });
            res.json({
                success: true,
                fechaEmision: new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' }),
                alumno: alumnos[0]
            });
        });
    });
});

app.post('/api/prestamo/renovar', (req, res) => {
    const { id_prestamo } = req.body;
    db.query("UPDATE prestamo SET fecha_devolucion = DATE_ADD(fecha_devolucion, INTERVAL 30 DAY) WHERE id_prestamo = ? AND estatus = 'activo'", [id_prestamo], (err, result) => {
        if (err || result.affectedRows === 0) return res.json({ success: false, message: 'No se pudo renovar.' });
        res.json({ success: true, message: '¡Préstamo renovado por 30 días más!' });
    });
});

app.post('/api/prestamo/devolver', (req, res) => {
    const { id_prestamo, id_libro } = req.body;
    db.beginTransaction(errTrans => {
        if (errTrans) return res.json({ success: false, message: 'Error en el servidor.' });
        db.query("UPDATE prestamo SET estatus = 'entregado' WHERE id_prestamo = ?", [id_prestamo], (errP) => {
            if (errP) return db.rollback(() => res.json({ success: false, message: 'Error al actualizar.' }));
            db.query("UPDATE libro SET disponibles = disponibles + 1 WHERE id_libro = ?", [id_libro], (errU) => {
                if (errU) return db.rollback(() => res.json({ success: false, message: 'Error al actualizar stock.' }));
                db.commit(errC => {
                    if (errC) return db.rollback(() => res.json({ success: false, message: 'Error al confirmar.' }));
                    res.json({ success: true, message: '¡Devolución registrada con éxito!' });
                });
            });
        });
    });
});

// --- 5. LÓGICA PRINCIPAL DE LOGIN, REGISTRO Y RECUPERACIÓN ---

app.post('/login', async (req, res) => {
    let { boleta, password } = req.body;
    boleta = boleta ? boleta.trim() : '';

    if (!boleta) return res.status(400).send('Por favor ingresa tu número de boleta.');

    db.query('SELECT * FROM alumno WHERE boleta = ?', [boleta], async (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(401).send('Boleta o usuario no encontrado en el sistema.');
        }

        const usuario = rows[0];
        if (usuario.rol === 'admin') {
            if (!password) return res.status(400).send('Los administradores deben ingresar contraseña.');
            const match = await bcrypt.compare(password, usuario.contrasena_encriptada);
            if (!match) return res.status(401).send('Contraseña incorrecta.');
            req.session.usuario = usuario;
            return res.redirect('/admin');
        } else {
            req.session.usuario = usuario;
            const queryParams = new URLSearchParams({
                boleta: usuario.boleta,
                nombre: usuario.nombre,
                adeudo: 'Sin adeudos ni sanciones pendientes. ¡Todo en orden!'
            }).toString();
            return res.redirect(`/menu?${queryParams}`);
        }
    });
});

// REGISTRO 100% LIBRE DE CORREO (Solo boleta, nombre, sexo, unidad)
app.post('/register', async (req, res) => {
    let { boleta, nombre, sexo, unidad_de_procedencia } = req.body;

    boleta = boleta ? boleta.trim() : '';
    nombre = nombre ? nombre.trim() : '';
    sexo = sexo ? sexo.trim() : 'No especificado';
    unidad_de_procedencia = unidad_de_procedencia ? unidad_de_procedencia.trim() : 'ESIME Zacatenco';

    if (!boleta || !nombre) {
        return res.status(400).send('Error: La boleta y el nombre son obligatorios.');
    }

    try {
        const hashedPassword = await bcrypt.hash('alumno_ipn', 10);
        const query = `
            INSERT INTO alumno (boleta, nombre, sexo, unidad_procedencia, email_institucional, contrasena_encriptada, rol) 
            VALUES (?, ?, ?, ?, NULL, ?, 'alumno')
        `;

        db.query(query, [boleta, nombre, sexo, unidad_de_procedencia, hashedPassword], (err) => {
            if (err) {
                console.error('Error al registrar alumno:', err);
                return res.status(400).send('Error al registrar: La boleta ya se encuentra registrada.');
            }
            return res.redirect('/login');
        });
    } catch (err) {
        res.status(500).send('Error interno en el servidor.');
    }
});

app.post('/forgot', async (req, res) => {
    let { boleta, new_password } = req.body;
    boleta = boleta ? boleta.trim() : '';

    if (!boleta || !new_password) return res.status(400).send('La boleta y la nueva contraseña son obligatorias.');

    try {
        db.query('SELECT * FROM alumno WHERE boleta = ?', [boleta], async (err, rows) => {
            if (err || rows.length === 0) return res.status(404).send('Boleta no encontrada.');
            const hashedPassword = await bcrypt.hash(new_password, 10);
            db.query('UPDATE alumno SET contrasena_encriptada = ? WHERE boleta = ?', [hashedPassword, boleta], (errUpdate) => {
                if (errUpdate) return res.status(500).send('Error al actualizar.');
                return res.redirect('/login');
            });
        });
    } catch (err) {
        res.status(500).send('Error interno.');
    }
});

// --- 6. INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Biblioteca Edificio 5 corriendo en http://localhost:${PORT}`);
});