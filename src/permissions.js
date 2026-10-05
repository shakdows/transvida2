'use strict';
// Catálogo de permisos y perfiles. La autorización real se aplica en el servidor (ver policy.js y routes.js).

const PERMISSIONS = {
  // Espacios de trabajo
  'workspace.gerencia': 'Espacio de gerencia',
  'workspace.operaciones': 'Espacio de operaciones',
  'workspace.conductor': 'Espacio de conductor',
  'workspace.mantenimiento': 'Espacio de mantenimiento',
  'workspace.finanzas': 'Espacio de finanzas',
  'workspace.admin': 'Espacio de administración del sistema',

  // Flota y recursos
  'fleet.view': 'Consultar flota, disponibilidad y restricciones técnicas',
  'fleet.manage': 'Alta y edición de fichas técnicas',
  'drivers.view': 'Consultar conductores y su disponibilidad',
  'clients.view': 'Consultar clientes',
  'clients.manage': 'Crear clientes',

  // Viajes
  'trips.view_all': 'Consultar todos los viajes',
  'trips.view_own': 'Consultar únicamente los viajes propios asignados',
  'trips.create': 'Crear y programar viajes',
  'trips.assign': 'Asignar vehículo, remolque y conductor',
  'trips.reschedule': 'Reprogramar y cancelar servicios con motivo',
  'trips.validate_close': 'Validar el cierre operativo',
  'trips.correct_event': 'Registrar correcciones de eventos operativos',
  'trips.driver_operate': 'Operar los viajes propios (confirmar, inspección, hitos, cierre)',
  'trips.financial_close': 'Realizar el cierre financiero del viaje',
  'trips.set_revenue': 'Registrar ingreso acordado y presupuesto del viaje',

  // Finanzas
  'finance.view_revenue': 'Ver ingresos y márgenes',
  'finance.view_costs': 'Ver costos totales por viaje, unidad y período',
  'finance.adjust': 'Registrar costos asignados y ajustes',
  'finance.export': 'Exportar información para conciliación',

  // Gastos
  'expenses.create_own': 'Registrar gastos en viajes propios',
  'expenses.create_any': 'Registrar gastos en cualquier viaje',
  'expenses.view_all': 'Consultar todos los gastos',
  'expenses.validate': 'Validar o rechazar gastos',

  // Incidencias
  'incidents.report_own': 'Reportar incidencias en viajes propios',
  'incidents.report_any': 'Registrar incidencias',
  'incidents.view_all': 'Consultar todas las incidencias',
  'incidents.view_mechanical': 'Consultar incidencias mecánicas',
  'incidents.resolve': 'Resolver incidencias',

  // Mantenimiento
  'maintenance.view': 'Consultar planes, órdenes e historial de mantenimiento',
  'maintenance.manage': 'Crear y registrar intervenciones',
  'maintenance.immobilize': 'Inmovilizar unidades',
  'maintenance.release': 'Liberar técnicamente unidades',
  'maintenance.view_costs': 'Ver costos de mantenimiento',
  'inspections.view_all': 'Consultar inspecciones previas',

  // Aprobaciones
  'approvals.request': 'Solicitar autorizaciones',
  'approvals.view_all': 'Consultar presupuestos y autorizaciones',
  'approvals.decide_expense': 'Aprobar gastos extraordinarios',
  'approvals.decide_maintenance': 'Aprobar presupuestos de mantenimiento',
  'approvals.decide_exception': 'Autorizar excepciones operativas',

  // Reportes y auditoría
  'reports.view': 'Consultar reportes globales',
  'reports.export': 'Exportar reportes',
  'audit.view_business': 'Consultar historial de decisiones',
  'audit.view_technical': 'Consultar auditoría técnica y de accesos',

  // Administración
  'users.manage': 'Crear, desactivar usuarios y asignar perfiles',
  'config.manage': 'Configurar categorías, umbrales y parámetros',
  'integrations.manage': 'Gestionar integraciones',

  // Portal de clientes (ampliación posterior, no habilitado en el MVP)
  'portal.view_own': 'Consultar los servicios propios del cliente',
};

const ROLES = {
  gerencia: {
    label: 'Gerencia / jefe de flota',
    home: 'resumen',
    permissions: [
      'workspace.gerencia', 'fleet.view', 'drivers.view', 'clients.view',
      'trips.view_all', 'finance.view_revenue', 'finance.view_costs',
      'expenses.view_all', 'incidents.view_all', 'maintenance.view', 'maintenance.view_costs',
      'inspections.view_all', 'approvals.view_all', 'approvals.decide_expense',
      'approvals.decide_maintenance', 'approvals.decide_exception',
      'reports.view', 'reports.export', 'audit.view_business',
    ],
  },
  operaciones: {
    label: 'Coordinador de operaciones / despachador',
    home: 'tablero',
    permissions: [
      'workspace.operaciones', 'fleet.view', 'drivers.view', 'clients.view', 'clients.manage',
      'trips.view_all', 'trips.create', 'trips.assign', 'trips.reschedule',
      'trips.validate_close', 'trips.correct_event', 'expenses.create_any', 'expenses.view_all',
      'incidents.report_any', 'incidents.view_all', 'incidents.resolve',
      'inspections.view_all', 'approvals.request',
    ],
    // Permisos que solo pueden concederse explícitamente (desactivados por defecto).
    optional: ['finance.view_revenue'],
  },
  conductor: {
    label: 'Conductor',
    home: 'mi-viaje',
    permissions: [
      'workspace.conductor', 'trips.view_own', 'trips.driver_operate',
      'expenses.create_own', 'incidents.report_own',
    ],
  },
  mantenimiento: {
    label: 'Responsable de mantenimiento',
    home: 'taller',
    permissions: [
      'workspace.mantenimiento', 'fleet.view', 'fleet.manage', 'trips.view_all',
      'incidents.view_mechanical', 'incidents.report_any', 'inspections.view_all',
      'maintenance.view', 'maintenance.manage', 'maintenance.immobilize',
      'maintenance.release', 'maintenance.view_costs', 'approvals.request',
    ],
  },
  finanzas: {
    label: 'Administración / finanzas',
    home: 'por-validar',
    permissions: [
      'workspace.finanzas', 'clients.view', 'trips.view_all', 'trips.financial_close',
      'trips.set_revenue', 'finance.view_revenue', 'finance.view_costs', 'finance.adjust',
      'finance.export', 'expenses.view_all', 'expenses.validate', 'maintenance.view_costs',
      'approvals.view_all', 'audit.view_business',
    ],
  },
  admin: {
    label: 'Administrador del sistema',
    home: 'usuarios',
    // Sin acceso financiero automático.
    permissions: [
      'workspace.admin', 'users.manage', 'config.manage', 'integrations.manage',
      'audit.view_technical',
    ],
  },
  cliente: {
    label: 'Cliente (portal externo — ampliación posterior)',
    home: 'portal',
    future: true,
    permissions: ['portal.view_own'],
  },
};

// Permisos financieros sensibles: nunca se otorgan a través del perfil técnico.
const FINANCIAL_PERMISSIONS = ['finance.view_revenue', 'finance.view_costs', 'finance.adjust', 'finance.export'];

function resolvePermissions(roles, explicit) {
  const set = new Set();
  for (const r of roles) for (const p of ROLES[r]?.permissions || []) set.add(p);
  for (const p of explicit) if (PERMISSIONS[p]) set.add(p);
  return set;
}

module.exports = { PERMISSIONS, ROLES, FINANCIAL_PERMISSIONS, resolvePermissions };
