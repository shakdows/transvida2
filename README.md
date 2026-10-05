# TRANSVIDA — usuarios, áreas de trabajo y permisos

MVP de gestión de flota y viajes organizado por perfiles. Cada usuario entra a un espacio de trabajo
con su propia navegación, pantalla inicial y acciones. **Todos los permisos se comprueban en el
servidor y sobre cada registro**: ocultar un botón no es la única defensa. Un conductor que cambia el
id de una URL o de una solicitud recibe `404` y el intento queda en la auditoría de accesos.

## Ejecutar

Requiere Node.js 22.5 o superior. No usa dependencias externas: emplea SQLite nativo (`node:sqlite`).

```bash
npm start          # http://localhost:3000 (crea data/transvida.db con datos de demostración)
npm test           # pruebas de aceptación por perfil, accesos indebidos y autoaprobación
npm run seed       # reinicia la base con los datos de demostración
```

Variables: `PORT` y `TRANSVIDA_DB` (ruta del archivo SQLite).

### Vercel

`src/app.js` exporta por defecto el manejador de solicitudes, que Vercel usa como función. En Vercel
solo `/tmp` admite escritura: la base se crea allí con los datos de demostración en cada instancia
nueva y **los cambios no persisten** (sirve como demo, no para operación real). Para producción hay
que usar una base externa.

### Cuentas de demostración (contraseña `demo1234`)

| Usuario | Perfil | Pantalla inicial |
|---|---|---|
| `gerencia` | Gerencia / jefe de flota | Resumen ejecutivo |
| `operaciones` | Coordinador de operaciones | Tablero operativo (sin ingresos ni márgenes) |
| `operaciones2` | Operaciones + permiso explícito `finance.view_revenue` | Tablero operativo |
| `conductor` / `conductor2` | Conductor | «Mi viaje» (móvil) |
| `mantenimiento` | Responsable de mantenimiento | Taller |
| `finanzas` | Administración / finanzas | Gastos por validar y cierres pendientes |
| `admin` | Administrador del sistema | Usuarios y accesos (sin acceso financiero) |
| `dueno` | Gerencia + operaciones (empresa pequeña) | Selector de espacio de trabajo |

## Arquitectura

```
src/
  permissions.js   catálogo de permisos y perfiles
  policy.js        alcance por registro y filtrado de campos sensibles
  routes.js        API: cada ruta declara su permiso y aplica el alcance
  services/        reglas de negocio (viajes, flota, gastos, mantenimiento, aprobaciones…)
  core.js          configuración, auditoría, notificaciones
  db.js            esquema SQLite con triggers que impiden borrar o alterar el historial
public/            interfaz web (módulos ES sin compilación)
test/              pruebas de aceptación por perfil y de seguridad
```

### Modelo de autorización

1. **Permisos explícitos.** Un usuario tiene uno o varios perfiles y, además, permisos sueltos
   concedidos explícitamente (`user_permissions`). Los permisos efectivos se recalculan en cada
   solicitud, así que desactivar un usuario o quitarle un perfil surte efecto de inmediato.
2. **Alcance por registro** (`policy.js`): `trips.view_all` frente a `trips.view_own`
   (`driver_id = usuario`). Gastos, incidencias, archivos y borradores se filtran igual. Los filtros
   de consulta (`?vehicle_id=`, `?trip_id=`) nunca amplían el alcance.
3. **Filtrado de campos**: ingresos y márgenes solo con `finance.view_revenue`; costos por viaje
   con `finance.view_costs`; costos de mantenimiento con `maintenance.view_costs`.
4. **Nadie decide sobre su propia solicitud**, aunque tenga varios perfiles: se compara con quien
   la solicitó y con quien creó el registro subyacente (gasto u orden de trabajo).
5. **Las restricciones técnicas críticas no tienen excepción.** Una unidad inmovilizada o en taller
   no se puede asignar, y ninguna aprobación lo cambia. Solo la liberación técnica levanta la
   restricción.
6. **Una solicitud pendiente no equivale a una autorización.** Las acciones que requieren
   aprobación buscan una aprobación con estado `aprobada`.
7. **CSRF**: la cookie de sesión es `HttpOnly; SameSite=Strict` y las mutaciones exigen
   `application/json`.

### Matriz resumida

| Capacidad | Gerencia | Operaciones | Conductor | Mantenimiento | Finanzas | Admin |
|---|---|---|---|---|---|---|
| Ver todos los viajes | ✔ | ✔ | solo propios | ✔ (programación) | ✔ | ✘ |
| Ingresos y márgenes | ✔ | opcional explícito | ✘ | ✘ | ✔ | ✘ |
| Crear, asignar y reprogramar viajes | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ |
| Confirmar, inspeccionar y reportar hitos | ✘ | ✘ | propios | ✘ | ✘ | ✘ |
| Validar el cierre operativo | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ |
| Cierre financiero, ajustes y validar gastos | ✘ | ✘ | ✘ | ✘ | ✔ | ✘ |
| Aprobar gastos, presupuestos y excepciones | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| Inmovilizar y liberar unidades | ✘ | ✘ | ✘ | ✔ | ✘ | ✘ |
| Usuarios, configuración e integraciones | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ |
| Auditoría | decisiones | ✘ | ✘ | ✘ | decisiones | técnica y accesos |

El detalle completo está en `src/permissions.js`.

## Circuito entre áreas

1. **Operaciones** crea el viaje y asigna tractor, remolque y conductor. Se rechazan las unidades
   inmovilizadas o en taller, los remolques usados como tractor y los recursos con horarios
   superpuestos.
2. **Conductor** confirma la recepción y completa la inspección previa (checklist y fotografías).
3. Una **falla crítica** (punto del checklist marcado `critical`) bloquea la salida. El sistema
   inmoviliza la unidad de forma preventiva, crea la incidencia y una orden de evaluación, y avisa a
   mantenimiento y al coordinador.
4. **Mantenimiento** evalúa, registra la intervención y realiza la **liberación técnica**. Esta no
   cancela reservas ni cambia asignaciones: el viaje sigue asignado y el conductor repite la
   inspección (u operaciones reasigna otra unidad).
5. El **conductor** reporta salida (km inicial), llegada al punto de carga, inicio de traslado,
   llegada al destino y fin de servicio (km final), en ese orden. También registra gastos con
   comprobante e incidencias.
6. Los **gastos extraordinarios** (monto superior al umbral o categoría marcada) requieren la
   aprobación de gerencia antes de que finanzas pueda validarlos.
7. El conductor **reporta el fin del servicio** y **solicita el cierre**. Son estados distintos de
   «operaciones validó cierre». El conductor nunca cierra financieramente.
8. **Operaciones valida el cierre operativo**. El vehículo, el remolque y el conductor quedan libres
   en ese momento, aunque falte el cierre financiero.
9. **Finanzas** valida o rechaza gastos (con motivo), registra costos asignados y realiza el cierre
   financiero, que fija ingreso, costo y margen. Las correcciones posteriores son ajustes con
   motivo; el cierre no se reescribe.
10. **Gerencia** consulta resultados, rentabilidad por viaje, unidad, cliente y mes, presupuesto
    frente a ejecución, unidades detenidas, alertas y el historial de decisiones.

## Trazabilidad

- `audit_log` registra quién, qué, cuándo, el motivo y los valores anteriores y nuevos. Unos
  triggers de la base impiden borrarlo o modificarlo.
- Los eventos operativos reportados no se modifican: operaciones agrega un evento de
  **corrección** con motivo.
- Los gastos enviados no se eliminan. Un gasto rechazado se conserva con su estado y su
  explicación.
- Las órdenes de trabajo cerradas no admiten cambios de costo. Los ajustes de costo
  (`cost_entries`) tampoco se modifican.
- Los intentos de acceso indebido (403 o 404 sobre un registro) quedan en la auditoría de accesos.

## Notificaciones

Las notificaciones se muestran dentro de la aplicación y se envían a quienes tienen el permiso
correspondiente. Cuando el texto incluye datos financieros, quien no tiene permiso recibe una
versión sin esos datos. El correo y WhatsApp son integraciones opcionales (Administración →
Integraciones): al activarlas se encola en `outbox` el mismo texto ya filtrado. El envío real
depende del proveedor que se conecte.

## Experiencia del conductor

- Diseño móvil con botones grandes y un único «siguiente paso» visible.
- Los formularios de inspección, gasto e incidencia se guardan como **borrador**, en el
  dispositivo y en el servidor.
- **Sin conexión**: cada registro se encola con un identificador único (`client_uuid`). La interfaz
  muestra qué registros están pendientes de sincronización. Al reenviarlos, el servidor devuelve el
  registro existente en lugar de duplicarlo. Si el servidor rechaza un registro, se marca como
  rechazado para que el conductor lo revise.
- El formulario de incidencias aclara que **no es un servicio de emergencias** ni un canal vigilado
  permanentemente.

## Portal de clientes (ampliación posterior)

La arquitectura está preparada, pero el portal **no está habilitado** en el MVP
(`PORTAL_ENABLED = false`):

- el perfil `cliente` y el permiso `portal.view_own` existen en el catálogo; el administrador no
  puede asignarlos mientras el portal esté deshabilitado;
- `users.client_id` vincula una cuenta con su cliente, y `tripScopeSql` ya restringe el alcance a
  `trips.client_id`;
- `serializeTripForClient` define la vista externa: estado, hitos, hora estimada e incidencias que
  operaciones marcó como comunicadas. Excluye costos, márgenes, datos de otros clientes y la
  ubicación exacta, salvo que exista una política y autorización explícitas.
