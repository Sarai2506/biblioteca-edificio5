require('dotenv').config(); // Cargamos las variables de entorno del archivo .env para la conexión segura
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./config/db'); // Importamos la conexión a nuestra base de datos en MariaDB

const app = express();

// --- CONFIGURACIÓN BÁSICA DEL SERVIDOR ---
app.use(express.urlencoded({ extended: true })); // Para poder leer lo que mandan los formularios HTML por POST
app.use(express.json()); // Para manejar JSON en las peticiones AJAX de las vistas

// Indicamos dónde están nuestros archivos estáticos (CSS, scripts, etc.) en la carpeta public
app.use(express.static(path.join(__dirname, 'public')));

// Configuramos las sesiones para mantener al usuario activo entre las páginas
app.use(session({
    secret: process.env.SESSION_SECRET || 'secreto_biblioteca_ipn',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// --- AUTO-CREACIÓN DEL ADMIN DE EMERGENCIA ---
// Borramos y recreamos el admin por si acaso para poder entrar a calar el panel de control
db.query("DELETE FROM alumno WHERE boleta = 'ADMIN001'", async (err) => {
    try {
        const hashedPassword = await bcrypt.hash('123456789', 10);
        const queryAdmin = `
            INSERT INTO alumno (boleta, nombre, sexo, unidad_procedencia, email_institucional, contrasena_encriptada, rol) 
            VALUES ('ADMIN001', 'Administrador General', 'No especificado', 'ESIME Zacatenco', NULL, ?, 'admin')
        `;
        db.query(queryAdmin, [hashedPassword], (errInsert) => {
            if (errInsert) {
                console.log('Chale, hubo error al meter al admin:', errInsert.message);
            } else {
                console.log('✔ Todo chido: El Admin (ADMIN001 / 123456789) ya quedó registrado en la BD.');
            }
        });
    } catch (e) {
        console.log('Error al encriptar la contra del admin:', e);
    }
});

// --- RUTAS GET PARA CARGAR LAS VISTAS HTML ---
app.get('/', (req, res) => { res.redirect('/login'); }); // La raiz nos manda directo al login por seguridad
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'login.html')); });
app.get('/register', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'register.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'admin.html')); });
app.get('/catalogo', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'catalogo.html')); });
app.get('/datos', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'datos.html')); });
app.get('/forgot', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'forgot.html')); });
app.get('/historial', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'historial.html')); });
app.get('/menu', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'menu.html')); });
app.get('/prestamo', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'prestamo.html')); });

// --- APIS Y CONSULTAS A LA BASE DE DATOS ---

// Endpoint para buscar libros en el catálogo con la barrita de texto
app.get('/api/libros', (req, res) => {
    const busqueda = req.query.q || '';
    const searchTerm = `%${busqueda}%`;
    const query = 'SELECT * FROM libro WHERE titulo LIKE ? OR autor LIKE ? OR isbn LIKE ?';

    db.query(query, [searchTerm, searchTerm, searchTerm], (err, results) => {
        if (err) {
            console.log('Error al hacer select en libros:', err);
            return res.status(500).json({ error: 'No se pudieron cargar los libros.' });
        }
        res.json(results); // Devolvemos el JSON con los libros encontrados
    });
});

// Endpoint para solicitar el préstamo de un libro (revisa stock y duplicados)
app.post('/api/prestamo/solicitar', (req, res) => {
    const { boleta, id_libro } = req.body;
    if (!boleta || !id_libro) return res.json({ success: false, message: 'Faltan datos para el préstamo.' });

    // Checamos que el alumno no tenga ya el mismo libro pedido sin devolver
    const queryVerificarDuplicado = "SELECT * FROM prestamo WHERE boleta = ? AND id_libro = ? AND estatus != 'devuelto' AND estatus != 'entregado'";

    db.query(queryVerificarDuplicado, [boleta, id_libro], (errDup, duplicados) => {
        if (errDup || duplicados.length > 0) {
            return res.json({ success: false, message: 'Aguas, ya tienes un préstamo activo de este libro.' });
        }

        // Vemos si hay ejemplares disponibles
        db.query('SELECT * FROM libro WHERE id_libro = ?', [id_libro], (err, libros) => {
            if (err || libros.length === 0 || libros[0].disponibles <= 0) {
                return res.json({ success: false, message: 'Lo siento, el libro ya está agotado.' });
            }

            // Usamos transacción por si falla algo al descontar del inventario
            db.beginTransaction(errTrans => {
                if (errTrans) return res.json({ success: false, message: 'Error en la transacción.' });

                const queryPrestamo = "INSERT INTO prestamo (boleta, id_libro, fecha_prestamo, fecha_devolucion, estatus, sancion) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 'activo', 'Ninguna')";

                db.query(queryPrestamo, [boleta, id_libro], (errP) => {
                    if (errP) return db.rollback(() => res.json({ success: false, message: 'Error al insertar préstamo.' }));

                    // Le restamos uno al stock disponible del libro
                    db.query('UPDATE libro SET disponibles = disponibles - 1 WHERE id_libro = ?', [id_libro], (errU) => {
                        if (errU) return db.rollback(() => res.json({ success: false, message: 'Error al actualizar stock.' }));

                        db.commit(errC => {
                            if (errC) return db.rollback(() => res.json({ success: false, message: 'Error al hacer commit.' }));
                            res.json({ success: true, message: '¡Listo! Préstamo registrado por 30 días.' });
                        });
                    });
                });
            });
        });
    });
});

// Sacar los préstamos activos de un alumno en específico
app.get('/api/prestamos/:boleta', (req, res) => {
    const query = "SELECT p.*, l.titulo, l.autor FROM prestamo p JOIN libro l ON p.id_libro = l.id_libro WHERE p.boleta = ? AND p.estatus != 'devuelto' AND p.estatus != 'entregado'";
    db.query(query, [req.params.boleta], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error al consultar préstamos.' });
        res.json(results);
    });
});

// Historial de libros ya entregados
app.get('/api/historial/:boleta', (req, res) => {
    const query = "SELECT p.*, l.titulo, l.autor FROM prestamo p JOIN libro l ON p.id_libro = l.id_libro WHERE p.boleta = ? AND (p.estatus = 'devuelto' OR p.estatus = 'entregado')";
    db.query(query, [req.params.boleta], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error al sacar el historial.' });
        res.json(results);
    });
});

// Filtrar movimientos por rango de fechas para la consulta del alumno
app.get('/api/alumno/historial-fechas', (req, res) => {
    const { boleta, inicio, fin } = req.query;
    const query = "SELECT p.*, l.titulo, l.autor FROM prestamo p JOIN libro l ON p.id_libro = l.id_libro WHERE p.boleta = ? AND p.fecha_prestamo BETWEEN ? AND ?";
    db.query(query, [boleta, `${inicio} 00:00:00`, `${fin} 23:59:59`], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error en fechas.' });
        res.json(results);
    });
});

// Validar si el alumno se puede llevar su Carta de No Adeudo
app.get('/api/alumno/carta-no-adeudo', (req, res) => {
    const boleta = req.query.boleta;
    const queryCheck = "SELECT * FROM prestamo WHERE boleta = ? AND (estatus = 'activo' OR estatus = 'retrasado' OR sancion = 'Castigo' OR sancion = 'Multa')";
    
    db.query(queryCheck, [boleta], (err, adeudos) => {
        if (err || adeudos.length > 0) {
            return res.json({ success: false, message: 'No puedes generar la carta porque tienes adeudos o sanciones pendientes.' });
        }

        db.query("SELECT * FROM alumno WHERE boleta = ?", [boleta], (errAlu, alumnos) => {
            if (errAlu || alumnos.length === 0) return res.json({ success: false, message: 'Alumno no localizado.' });
            res.json({
                success: true,
                fechaEmision: new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' }),
                alumno: alumnos[0]
            });
        });
    });
});

// Renovar por 30 días más un préstamo activo
app.post('/api/prestamo/renovar', (req, res) => {
    const { id_prestamo } = req.body;
    db.query("UPDATE prestamo SET fecha_devolucion = DATE_ADD(fecha_devolucion, INTERVAL 30 DAY) WHERE id_prestamo = ? AND estatus = 'activo'", [id_prestamo], (err, result) => {
        if (err || result.affectedRows === 0) return res.json({ success: false, message: 'No se pudo renovar el libro.' });
        res.json({ success: true, message: '¡Préstamo renovado otros 30 días!' });
    });
});

// Registrar la devolución física del libro y regresar stock
app.post('/api/prestamo/devolver', (req, res) => {
    const { id_prestamo, id_libro } = req.body;
    db.beginTransaction(errTrans => {
        if (errTrans) return res.json({ success: false, message: 'Error de servidor.' });
        db.query("UPDATE prestamo SET estatus = 'entregado' WHERE id_prestamo = ?", [id_prestamo], (errP) => {
            if (errP) return db.rollback(() => res.json({ success: false, message: 'Error al actualizar estatus.' }));
            db.query("UPDATE libro SET disponibles = disponibles + 1 WHERE id_libro = ?", [id_libro], (errU) => {
                if (errU) return db.rollback(() => res.json({ success: false, message: 'Error al sumar al stock.' }));
                db.commit(errC => {
                    if (errC) return db.rollback(() => res.json({ success: false, message: 'Error al hacer commit.' }));
                    res.json({ success: true, message: '¡Libro devuelto con éxito!' });
                });
            });
        });
    });
});

// --- LÓGICA DE ACCESO (LOGIN, REGISTRO Y RECUPERACIÓN) ---

// Validar el acceso (si es admin pide contra, si es alumno entra directo con la boleta)
app.post('/login', async (req, res) => {
    let { boleta, password } = req.body;
    boleta = boleta ? boleta.trim() : '';

    if (!boleta) return res.status(400).send('Falta poner el número de boleta.');

    db.query('SELECT * FROM alumno WHERE boleta = ?', [boleta], async (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(401).send('Esa boleta no está registrada en el sistema.');
        }

        const usuario = rows[0];
        if (usuario.rol === 'admin') {
            if (!password) return res.status(400).send('Los administradores deben meter su contraseña.');
            const match = await bcrypt.compare(password, usuario.contrasena_encriptada);
            if (!match) return res.status(401).send('Contraseña incorrecta, checale bien.');
            req.session.usuario = usuario;
            return res.redirect('/admin');
        } else {
            req.session.usuario = usuario;
            // Pasamos los datos por query string para que el menú los pinte fácil sin tanto relajo
            const queryParams = new URLSearchParams({
                boleta: usuario.boleta,
                nombre: usuario.nombre,
                adeudo: 'Sin adeudos ni sanciones pendientes. ¡Todo en orden!'
            }).toString();
            return res.redirect(`/menu?${queryParams}`);
        }
    });
});

// REGISTRO DE ALUMNOS (Aquí validamos que la boleta sea obligatoriamente de 10 dígitos numéricos)
app.post('/register', async (req, res) => {
    let { boleta, nombre, sexo, unidad_de_procedencia } = req.body;

    boleta = boleta ? boleta.trim() : '';
    nombre = nombre ? nombre.trim() : '';
    sexo = sexo ? sexo.trim() : 'No especificado';
    unidad_de_procedencia = unidad_de_procedencia ? unidad_de_procedencia.trim() : 'ESIME Zacatenco';

    // Validación estricta con RegEx: exactamente 10 números
    const regexBoleta = /^[0-9]{10}$/;
    if (!boleta || !regexBoleta.test(boleta)) {
        return res.status(400).send('Error: La boleta es obligatoria y tiene que ser exactamente de 10 dígitos numéricos.');
    }

    if (!nombre) {
        return res.status(400).send('Error: El nombre completo es obligatorio.');
    }

    try {
        const hashedPassword = await bcrypt.hash('alumno_ipn', 10);
        const query = `
            INSERT INTO alumno (boleta, nombre, sexo, unidad_procedencia, email_institucional, contrasena_encriptada, rol) 
            VALUES (?, ?, ?, ?, NULL, ?, 'alumno')
        `;

        db.query(query, [boleta, nombre, sexo, unidad_de_procedencia, hashedPassword], (err) => {
            if (err) {
                console.log('Error al insertar el alumno:', err);
                return res.status(400).send('Error al registrar: Probablemente esa boleta ya está dada de alta.');
            }
            return res.redirect('/login'); // Si todo sale bien, lo mandamos al login para que entre
        });
    } catch (err) {
        res.status(500).send('Error interno del servidor al registrar.');
    }
});

// Recuperar / cambiar contraseña (por si acaso la olvidan)
app.post('/forgot', async (req, res) => {
    let { boleta, new_password } = req.body;
    boleta = boleta ? boleta.trim() : '';

    if (!boleta || !new_password) return res.status(400).send('Llena todos los campos para actualizar.');

    try {
        db.query('SELECT * FROM alumno WHERE boleta = ?', [boleta], async (err, rows) => {
            if (err || rows.length === 0) return res.status(404).send('No encontré esa boleta en la base.');
            const hashedPassword = await bcrypt.hash(new_password, 10);
            db.query('UPDATE alumno SET contrasena_encriptada = ? WHERE boleta = ?', [hashedPassword, boleta], (errUpdate) => {
                if (errUpdate) return res.status(500).send('Error al actualizar la contra.');
                return res.redirect('/login');
            });
        });
    } catch (err) {
        res.status(500).send('Error interno.');
    }
});

// --- ARRANCAR EL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de la Biblioteca Edificio 5 jalando chido en http://localhost:${PORT}`);
});