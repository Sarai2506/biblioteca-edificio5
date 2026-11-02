require('dotenv').config(); // Carga las variables de entorno desde el archivo .env
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./config/db'); // Conexión a la base de datos MariaDB

const app = express();

// --- 1. MIDDLEWARES Y CONFIGURACIÓN DEL SISTEMA ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Servir archivos estáticos (CSS, JavaScript, Imágenes) desde la carpeta public
app.use(express.static(path.join(__dirname, 'public')));

// Configuración del motor de sesiones
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
            VALUES ('ADMIN001', 'Administrador General', 'No especificado', 'ESIME Zacatenco', 'admin001@ipn.mx', ?, 'admin')
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

// --- 3. RUTAS DE NAVEGACIÓN Y VISTAS (GET) ---
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Entrega directa de vistas HTML desde la carpeta views
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'login.html')); });
app.get('/register', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'register.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'admin.html')); });
app.get('/catalogo', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'catalogo.html')); });
app.get('/datos', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'datos.html')); });
app.get('/forgot', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'forgot.html')); });
app.get('/historial', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'historial.html')); });
app.get('/menu', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'menu.html')); });
app.get('/prestamo', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'prestamo.html')); });

// --- 4. RUTAS API PARA EL SISTEMA ---

// API: Obtener libros para el catálogo (con búsqueda)
app.get('/api/libros', (req, res) => {
    const busqueda = req.query.q || '';
    const searchTerm = `%${busqueda}%`;
    const query = `
        SELECT * FROM libro 
        WHERE titulo LIKE ? OR autor LIKE ? OR isbn LIKE ?
    `;

    db.query(query, [searchTerm, searchTerm, searchTerm], (err, results) => {
        if (err) {
            console.error('Error al buscar libros:', err);
            return res.status(500).json({ error: 'Error al obtener los libros.' });
        }
        res.json(results);
    });
});

// API: Solicitar préstamo de un libro (con validación de duplicados activos)
app.post('/api/prestamo/solicitar', (req, res) => {
    const { boleta, id_libro } = req.body;

    if (!boleta || !id_libro) {
        return res.json({ success: false, message: 'Datos incompletos para el préstamo.' });
    }

    const queryVerificarDuplicado = `
        SELECT * FROM prestamo 
        WHERE boleta = ? AND id_libro = ? AND estatus != 'devuelto' AND estatus != 'entregado'
    `;

    db.query(queryVerificarDuplicado, [boleta, id_libro], (errDup, duplicados) => {
        if (errDup) {
            return res.json({ success: false, message: 'Error al verificar préstamos anteriores.' });
        }

        if (duplicados.length > 0) {
            return res.json({ success: false, message: 'No puedes solicitar dos veces el mismo libro mientras tengas un préstamo activo de este.' });
        }

        db.query('SELECT * FROM libro WHERE id_libro = ?', [id_libro], (err, libros) => {
            if (err || libros.length === 0) {
                return res.json({ success: false, message: 'Libro no encontrado.' });
            }

            const libro = libros[0];
            if (libro.disponibles <= 0) {
                return res.json({ success: false, message: 'Lo sentimos, el libro está agotado temporalmente.' });
            }

            db.beginTransaction(errTrans => {
                if (errTrans) return res.json({ success: false, message: 'Error interno en el servidor.' });

                const queryPrestamo = `
                    INSERT INTO prestamo (boleta, id_libro, fecha_prestamo, fecha_devolucion, estatus, sancion) 
                    VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 'activo', 'Ninguna')
                `;

                db.query(queryPrestamo, [boleta, id_libro], (errP) => {
                    if (errP) {
                        return db.rollback(() => res.json({ success: false, message: 'Error al registrar el préstamo.' }));
                    }

                    db.query('UPDATE libro SET disponibles = disponibles - 1 WHERE id_libro = ?', [id_libro], (errU) => {
                        if (errU) {
                            return db.rollback(() => res.json({ success: false, message: 'Error al actualizar la disponibilidad.' }));
                        }

                        db.commit(errC => {
                            if (errC) return db.rollback(() => res.json({ success: false, message: 'Error al confirmar la transacción.' }));
                            res.json({ success: true, message: '¡Préstamo solicitado con éxito por un plazo de 30 días!' });
                        });
                    });
                });
            });
        });
    });
});

// API: Obtener los préstamos activos/retrasados de un alumno específico
app.get('/api/prestamos/:boleta', (req, res) => {
    const boleta = req.params.boleta;
    const query = `
        SELECT p.*, l.titulo, l.autor 
        FROM prestamo p 
        JOIN libro l ON p.id_libro = l.id_libro 
        WHERE p.boleta = ? AND p.estatus != 'devuelto' AND p.estatus != 'entregado'
    `;

    db.query(query, [boleta], (err, results) => {
        if (err) {
            console.error('Error al obtener préstamos:', err);
            return res.status(500).json({ error: 'Error al obtener los préstamos.' });
        }
        res.json(results);
    });
});

// API: Historial de préstamos entregados para historial.html
app.get('/api/historial/:boleta', (req, res) => {
    const boleta = req.params.boleta;
    const query = `
        SELECT p.*, l.titulo, l.autor 
        FROM prestamo p 
        JOIN libro l ON p.id_libro = l.id_libro 
        WHERE p.boleta = ? AND (p.estatus = 'devuelto' OR p.estatus = 'entregado')
    `;

    db.query(query, [boleta], (err, results) => {
        if (err) {
            console.error('Error al obtener historial:', err);
            return res.status(500).json({ error: 'Error al obtener el historial.' });
        }
        res.json(results);
    });
});

// API: Historial por rango de fechas (para datos.html)
app.get('/api/alumno/historial-fechas', (req, res) => {
    const { boleta, inicio, fin } = req.query;
    const query = `
        SELECT p.*, l.titulo, l.autor 
        FROM prestamo p 
        JOIN libro l ON p.id_libro = l.id_libro 
        WHERE p.boleta = ? AND p.fecha_prestamo BETWEEN ? AND ?
    `;

    db.query(query, [boleta, `${inicio} 00:00:00`, `${fin} 23:59:59`], (err, results) => {
        if (err) {
            console.error('Error en historial por fechas:', err);
            return res.status(500).json({ error: 'Error al consultar movimientos.' });
        }
        res.json(results);
    });
});

// API: Carta de no adeudo (para datos.html - Verifica que no tenga castigos ni multas pendientes)
app.get('/api/alumno/carta-no-adeudo', (req, res) => {
    const boleta = req.query.boleta;
    
    const queryCheck = "SELECT * FROM prestamo WHERE boleta = ? AND (estatus = 'activo' OR estatus = 'retrasado' OR sancion = 'Castigo' OR sancion = 'Multa')";
    db.query(queryCheck, [boleta], (err, adeudos) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en el servidor.' });

        if (adeudos.length > 0) {
            return res.json({ success: false, message: 'No es posible generar la Carta de No Adeudo porque tienes préstamos pendientes, multas o sanciones activas.' });
        }

        db.query("SELECT * FROM alumno WHERE boleta = ?", [boleta], (errAlu, alumnos) => {
            if (errAlu || alumnos.length === 0) {
                return res.json({ success: false, message: 'Alumno no encontrado.' });
            }

            const opcionesFecha = { year: 'numeric', month: 'long', day: 'numeric' };
            const fechaEmision = new Date().toLocaleDateString('es-MX', opcionesFecha);

            res.json({
                success: true,
                fechaEmision,
                alumno: alumnos[0]
            });
        });
    });
});

// API: Renovar préstamo
app.post('/api/prestamo/renovar', (req, res) => {
    const { id_prestamo } = req.body;
    const query = "UPDATE prestamo SET fecha_devolucion = DATE_ADD(fecha_devolucion, INTERVAL 30 DAY) WHERE id_prestamo = ? AND estatus = 'activo'";

    db.query(query, [id_prestamo], (err, result) => {
        if (err || result.affectedRows === 0) {
            return res.json({ success: false, message: 'No se pudo renovar el préstamo.' });
        }
        res.json({ success: true, message: '¡Préstamo renovado exitosamente por 30 días más!' });
    });
});

// API: Devolver libro
app.post('/api/prestamo/devolver', (req, res) => {
    const { id_prestamo, id_libro } = req.body;

    db.beginTransaction(errTrans => {
        if (errTrans) return res.json({ success: false, message: 'Error en el servidor.' });

        db.query("UPDATE prestamo SET estatus = 'entregado' WHERE id_prestamo = ?", [id_prestamo], (errP) => {
            if (errP) return db.rollback(() => res.json({ success: false, message: 'Error al actualizar el préstamo.' }));

            db.query("UPDATE libro SET disponibles = disponibles + 1 WHERE id_libro = ?", [id_libro], (errU) => {
                if (errU) return db.rollback(() => res.json({ success: false, message: 'Error al actualizar el stock.' }));

                db.commit(errC => {
                    if (errC) return db.rollback(() => res.json({ success: false, message: 'Error al confirmar.' }));
                    res.json({ success: true, message: '¡Devolución registrada con éxito!' });
                });
            });
        });
    });
});

// --- 5. APIS PARA EL PANEL DE ADMINISTRACIÓN (admin.html) ---

app.get('/api/admin/data', (req, res) => {
    db.query('SELECT * FROM libro', (errL, libros) => {
        db.query('SELECT boleta, nombre, sexo, unidad_procedencia AS unidad_de_procedencia, email_institucional AS email, rol FROM alumno', (errU, usuarios) => {
            const queryAdeudos = `
                SELECT p.*, l.titulo, al.nombre AS alumno 
                FROM prestamo p 
                JOIN libro l ON p.id_libro = l.id_libro 
                JOIN alumno al ON p.boleta = al.boleta
            `;
            db.query(queryAdeudos, (errA, adeudos) => {
                const adeudosMapeados = (adeudos || []).map(a => ({
                    ...a,
                    estatus: a.estatus === 'activo' ? 'activo' : a.estatus 
                }));

                // Para la pestaña de visitas/sanciones, pasamos todos los registros de préstamos/visitas
                db.query(queryAdeudos, (errV, visitas) => {
                    res.json({
                        libros: libros || [],
                        usuarios: usuarios || [],
                        adeudos: adeudosMapeados,
                        visitas: visitas || []
                    });
                });
            });
        });
    });
});

// API: Actualizar evaluación, observaciones y sanciones desde admin.html
app.post('/api/admin/visitas/actualizar/:id', (req, res) => {
    const id_prestamo = req.params.id;
    const { observaciones, sancion } = req.body;
    const query = "UPDATE prestamo SET observaciones = ?, sancion = ? WHERE id_prestamo = ?";

    db.query(query, [observaciones, sancion, id_prestamo], (err) => {
        if (err) {
            console.error('Error al actualizar sanción:', err);
            return res.status(500).send('Error al actualizar la sanción.');
        }
        res.redirect('/admin');
    });
});

app.post('/api/admin/libros/crear', (req, res) => {
    const { titulo, autor, isbn, descripcion, cantidad_total } = req.body;
    const query = "INSERT INTO libro (titulo, autor, isbn, descripcion, cantidad_total, disponibles) VALUES (?, ?, ?, ?, ?, ?)";
    
    db.query(query, [titulo, autor, isbn, descripcion, cantidad_total, cantidad_total], (err) => {
        if (err) return res.status(500).send('Error al registrar libro.');
        res.redirect('/admin');
    });
});

app.post('/api/admin/libros/actualizar/:id', (req, res) => {
    const id = req.params.id;
    const { titulo, autor, isbn, descripcion, cantidad_total, disponibles } = req.body;
    const query = "UPDATE libro SET titulo=?, autor=?, isbn=?, descripcion=?, cantidad_total=?, disponibles=? WHERE id_libro=?";

    db.query(query, [titulo, autor, isbn, descripcion, cantidad_total, disponibles, id], (err) => {
        if (err) return res.status(500).send('Error al actualizar libro.');
        res.redirect('/admin');
    });
});

app.get('/api/admin/libros/eliminar/:id', (req, res) => {
    db.query("DELETE FROM libro WHERE id_libro = ?", [req.params.id], (err) => {
        if (err) return res.status(500).send('Error al eliminar libro.');
        res.redirect('/admin');
    });
});

app.post('/api/admin/usuarios/actualizar/:boleta', (req, res) => {
    const boleta = req.params.boleta;
    const { nombre, sexo, unidad, email, rol } = req.body;
    const query = "UPDATE alumno SET nombre=?, sexo=?, unidad_procedencia=?, email_institucional=?, rol=? WHERE boleta=?";

    db.query(query, [nombre, sexo, unidad, email, rol, boleta], (err) => {
        if (err) return res.status(500).send('Error al actualizar usuario.');
        res.redirect('/admin');
    });
});

app.get('/api/admin/usuarios/eliminar/:boleta', (req, res) => {
    db.query("DELETE FROM alumno WHERE boleta = ?", [req.params.boleta], (err) => {
        if (err) return res.status(500).send('Error al eliminar usuario.');
        res.redirect('/admin');
    });
});

// --- 6. LÓGICA DE PROCESAMIENTO (LOGIN, REGISTRO Y RECUPERACIÓN) ---

app.post('/login', async (req, res) => {
    const { boleta, password } = req.body;

    if (!boleta) {
        return res.status(400).send('Por favor ingresa tu número de boleta.');
    }

    try {
        db.query('SELECT * FROM alumno WHERE boleta = ?', [boleta], async (err, rows) => {
            if (err) {
                console.error('Error en base de datos:', err);
                return res.status(500).send('Error interno en la base de datos.');
            }
            
            if (!rows || rows.length === 0) {
                return res.status(401).send('Boleta o usuario no encontrado en el sistema.');
            }

            const usuario = rows[0];

            if (usuario.rol === 'admin') {
                if (!password) {
                    return res.status(400).send('Los administradores deben ingresar su contraseña.');
                }
                if (!usuario.contrasena_encriptada) {
                    return res.status(400).send('El administrador no tiene una contraseña asignada.');
                }

                const passwordMatch = await bcrypt.compare(password, usuario.contrasena_encriptada);
                if (!passwordMatch) {
                    return res.status(401).send('Contraseña de administrador incorrecta.');
                }

                req.session.usuario = usuario;
                return res.redirect('/admin');
            } 
            else {
                req.session.usuario = usuario;

                const queryParams = new URLSearchParams({
                    boleta: usuario.boleta,
                    nombre: usuario.nombre,
                    adeudo: 'Sin adeudos ni sanciones pendientes. ¡Todo en orden!'
                }).toString();
                
                return res.redirect(`/menu?${queryParams}`);
            }
        });

    } catch (err) {
        console.error('Error en el servidor al procesar el login:', err);
        res.status(500).send('Error interno en el servidor.');
    }
});

// REGISTRO DE ALUMNOS (CON VALIDACIONES ESTRICTAS)
app.post('/register', async (req, res) => {
    let { boleta, nombre, sexo, unidad_procedencia, email_institucional } = req.body;

    const boletaRegex = /^\d{10}$/;
    if (!boleta || !boletaRegex.test(boleta)) {
        return res.status(400).send('Error: El número de boleta debe tener exactamente 10 dígitos numéricos.');
    }

    if (!email_institucional || !email_institucional.endsWith('@alumno.ipn.mx')) {
        return res.status(400).send('Error: El correo institucional debe terminar obligatoriamente con la extensión @alumno.ipn.mx');
    }

    unidad_procedencia = unidad_procedencia || 'ESIME Zacatenco';
    sexo = sexo || 'No especificado';

    try {
        const dummyPasswordHash = await bcrypt.hash('alumno_ipn', 10);

        const query = `
            INSERT INTO alumno (boleta, nombre, sexo, unidad_procedencia, email_institucional, contrasena_encriptada, rol) 
            VALUES (?, ?, ?, ?, ?, ?, 'alumno')
        `;

        db.query(query, [boleta, nombre, sexo, unidad_procedencia, email_institucional, dummyPasswordHash], (err, result) => {
            if (err) {
                console.error('Error al registrar alumno en BD:', err);
                return res.status(400).send('Error al registrar. La boleta o el correo institucional ya se encuentran registrados.');
            }

            return res.redirect('/login');
        });

    } catch (err) {
        console.error('Error al registrar alumno:', err);
        res.status(500).send('Error interno en el servidor.');
    }
});

app.post('/forgot', async (req, res) => {
    const { boleta, email, new_password } = req.body;

    if (!boleta || !email || !new_password) {
        return res.status(400).send('Todos los campos son obligatorios para restablecer la contraseña.');
    }

    try {
        db.query('SELECT * FROM alumno WHERE boleta = ? AND email_institucional = ?', [boleta, email], async (err, rows) => {
            if (err) {
                console.error('Error en base de datos:', err);
                return res.status(500).send('Error interno en el servidor.');
            }

            if (!rows || rows.length === 0) {
                return res.status(404).send('No se encontró ningún usuario con esa boleta y correo institucional.');
            }

            const hashedPassword = await bcrypt.hash(new_password, 10);

            db.query('UPDATE alumno SET contrasena_encriptada = ? WHERE boleta = ?', [hashedPassword, boleta], (errUpdate) => {
                if (errUpdate) {
                    console.error('Error al actualizar la contraseña:', errUpdate);
                    return res.status(500).send('Error al actualizar la contraseña en la base de datos.');
                }

                return res.redirect('/login');
            });
        });
    } catch (err) {
        console.error('Error interno al recuperar contraseña:', err);
        res.status(500).send('Error interno en el servidor.');
    }
});

// --- 7. INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de la Biblioteca Edificio 5 corriendo en http://localhost:${PORT}`);
});