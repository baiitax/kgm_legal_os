/**
 * FIRM OS DICTIONARY.
 *
 * Arabic is the SOURCE OF TRUTH and English is the peer (§ Arabic-first). Keys
 * are written against the Arabic intent first; where the two languages need
 * different phrasing rather than a translation, both are written out rather than
 * one being derived from the other.
 *
 * THIS FILE IS NOT SHARED WITH THE CLIENT PORTAL, and the separation is
 * substantive rather than organisational. The two products do not mean the same
 * things by the same words:
 *
 *   - A portal user's "matter" is a case they are a party to. A firm member's
 *     "matter" is a portfolio item with an access level, a risk rating and a
 *     billing arrangement.
 *   - "Restricted" does not exist for a client. For a member it is a §27 state
 *     with an audit trail and a reason they may or may not be entitled to read.
 *   - "Withheld" has no client-side meaning at all.
 *
 * One dictionary serving both would force one product's vocabulary onto the
 * other, and the first compromise would be a firm-only concept leaking into
 * client-facing copy — which is a disclosure bug with a translation file as its
 * vector.
 *
 * LEGAL TERMINOLOGY
 *   Saudi legal Arabic is used throughout: دعوى not قضية where a pleading is
 *   meant, جلسة for a hearing, موعد نهائي for a deadline, حيازة/وكالة for POA.
 *   These are the terms a Saudi practitioner expects, and generic Modern Standard
 *   Arabic substitutes read as translated software.
 */
import type { I18nBundle } from '@kgm/ui';

const ar = {
  // ---- shell / navigation (§12) -----------------------------------------
  'app.name': 'KGM LEGAL OS',
  'app.tagline': 'مساحة العمل الآمنة',
  'app.shortName': 'KGM',

  'nav.section.main': 'الرئيسية',
  'nav.section.legal': 'الشؤون القانونية',
  'nav.section.business': 'الأعمال',
  'nav.section.governance': 'الحوكمة',

  'nav.dashboard': 'لوحة القيادة',
  'nav.workspace': 'مساحة العمل',
  'nav.myWork': 'عملي',
  'nav.tasks': 'المهام',
  'nav.calendar': 'التقويم',
  'nav.notifications': 'الإشعارات',
  'nav.clients': 'العملاء',
  'nav.matters': 'الدعاوى',
  'nav.legal': 'القانونية',
  'nav.hearings': 'الجلسات',
  'nav.deadlines': 'المواعيد النهائية',
  'nav.documents': 'المستندات',
  'nav.contracts': 'العقود',
  'nav.poa': 'الوكالات',
  'nav.finance': 'المالية',
  'nav.time': 'الوقت',
  'nav.expenses': 'المصروفات',
  'nav.billing': 'الفوترة',
  'nav.collections': 'التحصيل',
  'nav.compliance': 'الامتثال',
  'nav.conflicts': 'تعارض المصالح',
  'nav.licences': 'التراخيص',
  'nav.training': 'التدريب',
  'nav.complaints': 'الشكاوى',
  'nav.communication': 'التواصل',
  'nav.messages': 'الرسائل',
  'nav.admin': 'الإدارة',
  'nav.users': 'المستخدمون',
  'nav.teams': 'الفرق',
  'nav.settings': 'الإعدادات',
  'nav.audit': 'سجل التدقيق',

  'nav.planned': 'قيد التطوير',
  'nav.collapse': 'طي القائمة',
  'nav.expand': 'توسيع القائمة',
  'nav.noModules': 'لا توجد وحدات متاحة لحسابك',
  'nav.noModulesHint': 'يرجى التواصل مع مدير النظام لمنح الصلاحيات اللازمة.',

  // ---- topbar (§13) ------------------------------------------------------
  'topbar.search': 'ابحث في العملاء والدعاوى والمستندات…',
  'topbar.searchShort': 'بحث',
  'topbar.commandPalette': 'لوحة الأوامر',
  'topbar.notifications': 'الإشعارات',
  'topbar.language': 'اللغة',
  'topbar.theme': 'المظهر',
  'topbar.help': 'المساعدة',
  'topbar.profile': 'الملف الشخصي',
  'topbar.switchLanguage': 'English',
  'topbar.tenant': 'الكيان',

  'theme.dark': 'داكن',
  'theme.light': 'فاتح',
  'theme.system': 'حسب النظام',

  // ---- mobile (§15-§17) --------------------------------------------------
  'mobile.home': 'الرئيسية',
  'mobile.matters': 'الدعاوى',
  'mobile.tasks': 'المهام',
  'mobile.docs': 'المستندات',
  'mobile.more': 'المزيد',
  'mobile.moreTitle': 'جميع الوحدات',
  'mobile.close': 'إغلاق',
  'mobile.pullToRefresh': 'اسحب للتحديث',

  // ---- auth (§52) --------------------------------------------------------
  'auth.signInTitle': 'تسجيل دخول الموظفين',
  'auth.signInSubtitle': 'مساحة العمل الداخلية — دخول بدعوة فقط',
  'auth.email': 'البريد الإلكتروني المهني',
  'auth.password': 'كلمة المرور',
  'auth.remember': 'إبقاء الجلسة نشطة على هذا الجهاز',
  'auth.rememberHint': 'تمدد مهلة الخمول إلى ١٢ ساعة بدلاً من ٣٠ دقيقة.',
  'auth.submit': 'دخول',
  'auth.signingIn': 'جارٍ التحقق…',
  'auth.signOut': 'تسجيل الخروج',
  'auth.clientPortalLink': 'بوابة العملاء',
  'auth.clientPortalNote': 'هذه المساحة مخصصة لموظفي المكتب فقط.',

  'auth.mfaTitle': 'التحقق الثنائي',
  'auth.mfaSubtitle': 'أدخل الرمز من تطبيق المصادقة',
  'auth.mfaCode': 'رمز التحقق',
  'auth.mfaVerify': 'تحقق',
  'auth.mfaDest': 'الوجهة',
  'auth.mfaExpires': 'تنتهي خلال {n} دقيقة',
  'auth.mfaBack': 'رجوع',

  'auth.err.invalid': 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
  'auth.err.locked': 'تم قفل الحساب مؤقتاً بسبب تكرار المحاولات. حاول لاحقاً.',
  'auth.err.noMembership': 'لا توجد عضوية نشطة مرتبطة بهذا الحساب',
  'auth.err.network': 'تعذّر الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.',
  'auth.err.generic': 'تعذّر إتمام تسجيل الدخول',
  'auth.err.required': 'هذا الحقل مطلوب',
  'auth.err.emailFormat': 'أدخل بريداً إلكترونياً صحيحاً',

  'auth.demoHint': 'بيانات تجريبية — جميع الحسابات وهمية',
  'auth.demoPartner': 'الشريكة الإدارية',
  'auth.demoLawyer': 'محامٍ أول',
  'auth.demoParalegal': 'مساعدة قانونية',
  'auth.demoCompliance': 'الامتثال',
  'auth.demoFinance': 'المالية · فوترة',
  'auth.demoUse': 'استخدام',

  'auth.securityNote': 'كل إجراء في هذه المساحة مسجّل ومدقّق.',

  // ---- dashboard (§19-§20) ----------------------------------------------
  'dash.greeting.morning': 'صباح الخير',
  'dash.greeting.afternoon': 'مساء الخير',
  'dash.greeting.evening': 'مساء الخير',
  'dash.greeting.night': 'مساء الخير',
  'dash.subtitle': 'نظرة عامة على أداء المكتب',
  'dash.subtitleScoped': 'نظرة عامة على نطاق صلاحياتك',

  'dash.activeMatters': 'الدعاوى النشطة',
  'dash.pendingHearings': 'جلسات قادمة',
  'dash.outstanding': 'المبالغ القائمة',
  'dash.overdue': 'المتأخرات',
  'dash.deadlinesThisWeek': 'مواعيد هذا الأسبوع',
  'dash.documentsPending': 'مستندات بانتظار الاعتماد',
  'dash.utilization': 'نسبة الاستغلال',
  'dash.newClients': 'عملاء جدد',

  'dash.trend.thisMonth': 'هذا الشهر',
  'dash.trend.vsLastMonth': 'مقارنة بالشهر الماضي',
  'dash.trend.up': 'ارتفاع {pct}',
  'dash.trend.down': 'انخفاض {pct}',
  'dash.trend.flat': 'بدون تغيّر',

  'dash.yourMatters': 'دعاواك',
  'dash.yourMattersHint': 'الدعاوى المسندة إليك',
  'dash.recentActivity': 'النشاط الأخير',
  'dash.upcomingDeadlines': 'المواعيد القادمة',
  'dash.attention': 'يحتاج انتباهك',
  'dash.viewAll': 'عرض الكل',
  'dash.noMetrics': 'لا توجد مؤشرات متاحة ضمن صلاحياتك',

  'dash.scopeNotice': 'تعرض هذه اللوحة البيانات ضمن نطاق ممارستك وصلاحياتك فقط.',

  // ---- matters (§21-§22) -------------------------------------------------
  'matter.title': 'الدعاوى',
  'matter.count': '{n} دعوى',
  'matter.countOne': 'دعوى واحدة',
  'matter.search': 'ابحث برقم الدعوى أو الاسم أو العميل',
  'matter.filters': 'التصفية',
  'matter.filter.status': 'الحالة',
  'matter.filter.practiceArea': 'مجال الممارسة',
  'matter.filter.access': 'مستوى الصلاحية',
  'matter.filter.restricted': 'المقيّدة فقط',
  'matter.filter.clear': 'مسح التصفية',
  'matter.sort.newest': 'الأحدث',
  'matter.sort.oldest': 'الأقدم',
  'matter.sort.number': 'رقم الدعوى',

  'matter.client': 'العميل',
  'matter.caseNumber': 'رقم القضية',
  'matter.matterNumber': 'رقم الدعوى',
  'matter.status': 'الحالة',
  'matter.practiceArea': 'مجال الممارسة',
  'matter.leadLawyer': 'المحامي المسؤول',
  'matter.nextHearing': 'الجلسة القادمة',
  'matter.deadline': 'الموعد النهائي',
  'matter.priority': 'الأولوية',
  'matter.openedAt': 'تاريخ الفتح',
  'matter.court': 'المحكمة',
  'matter.teamRole': 'دورك في الدعوى',
  'matter.department': 'القسم',
  'matter.accessLevel': 'مستوى صلاحيتك',

  'matter.restricted': 'دعوى مقيّدة',
  'matter.restrictedNote': 'الوصول لهذه الدعوى بتصريح صريح فقط.',
  'matter.restrictionReason': 'سبب التقييد',

  'matter.empty.title': 'لا توجد دعاوى',
  'matter.empty.body': 'لم تُسند إليك أي دعاوى ضمن نطاق ممارستك الحالي.',
  'matter.emptyFiltered.title': 'لا توجد نتائج',
  'matter.emptyFiltered.body': 'لم تطابق أي دعوى عوامل التصفية المحددة.',

  'matter.denied.title': 'لا يمكنك عرض هذه الدعوى',
  'matter.denied.body': 'هذه الدعوى غير متاحة ضمن صلاحياتك، أو أنها غير موجودة.',

  'matter.error.title': 'تعذّر تحميل الدعوى',
  'matter.error.body': 'حدث خطأ أثناء جلب البيانات.',
  'matter.retry': 'إعادة المحاولة',

  // ---- matter workspace tabs (§22) --------------------------------------
  'tab.overview': 'نظرة عامة',
  'tab.timeline': 'المسار الزمني',
  'tab.team': 'الفريق',
  'tab.documents': 'المستندات',
  'tab.hearings': 'الجلسات',
  'tab.deadlines': 'المواعيد',
  'tab.contracts': 'العقود',
  'tab.poa': 'الوكالات',
  'tab.time': 'الوقت',
  'tab.expenses': 'المصروفات',
  'tab.billing': 'الفوترة',
  'tab.messages': 'الرسائل',
  'tab.compliance': 'الامتثال',

  // ---- §57 classification ------------------------------------------------
  'cls.withheld': 'حقل محجوب',
  'cls.withheldHint': 'هذا الحقل مصنّف ولا يظهر لمستوى صلاحيتك على هذه الدعوى.',
  'cls.withheldCount': '{n} حقل محجوب حسب التصنيف',
  'cls.accessExplainer': 'مستوى صلاحيتك على هذه الدعوى هو «{level}»، وهو يحدد الحقول التي تظهر لك.',
  'cls.internalNotes': 'ملاحظات داخلية',
  'cls.riskRating': 'تقييم المخاطر',
  'cls.conflictCleared': 'تم التحقق من تعارض المصالح',
  'cls.summary': 'الملخص',
  'cls.internalStatus': 'الحالة الداخلية',

  // ---- timeline (§23) ----------------------------------------------------
  'timeline.title': 'المسار الزمني',
  'timeline.empty': 'لا توجد أحداث مسجلة بعد.',
  'timeline.today': 'اليوم',

  // ---- alerts (§31) ------------------------------------------------------
  'alert.info': 'معلومة',
  'alert.notice': 'تنبيه',
  'alert.warning': 'تحذير',
  'alert.high': 'مرتفع',
  'alert.critical': 'حرج',
  'alert.deadlineApproaching': 'موعد نهائي قريب',
  'alert.mattersNeedAttention': '{n} دعوى تحتاج اهتمامك اليوم.',

  // ---- common ------------------------------------------------------------
  'common.loading': 'جارٍ التحميل…',
  'common.save': 'حفظ',
  'common.cancel': 'إلغاء',
  'common.close': 'إغلاق',
  'common.confirm': 'تأكيد',
  'common.search': 'بحث',
  'common.filter': 'تصفية',
  'common.sort': 'ترتيب',
  'common.export': 'تصدير',
  'common.columns': 'الأعمدة',
  'common.savedViews': 'طرق العرض المحفوظة',
  'common.bulkActions': 'إجراءات جماعية',
  'common.selected': '{n} محدد',
  'common.refresh': 'تحديث',
  'common.back': 'رجوع',
  'common.next': 'التالي',
  'common.previous': 'السابق',
  'common.page': 'صفحة {p} من {t}',
  'common.rows': '{from}–{to} من {total}',
  'common.none': '—',
  'common.yes': 'نعم',
  'common.no': 'لا',
  'common.all': 'الكل',
  'common.optional': 'اختياري',
  'common.required': 'مطلوب',
  'common.copy': 'نسخ',
  'common.copied': 'تم النسخ',

  'common.error.title': 'حدث خطأ',
  'common.error.body': 'تعذّر إتمام هذا الإجراء.',
  'common.error.network': 'تعذّر الاتصال بالخادم',
  'common.denied.title': 'لا تملك صلاحية',
  'common.denied.body': 'طلبك مرفوض وفقاً لسياسات الصلاحيات في المكتب.',
  'common.notFound.title': 'غير موجود',
  'common.notFound.body': 'الصفحة المطلوبة غير متاحة.',

  'common.sessionExpired': 'انتهت الجلسة',
  'common.sessionExpiredBody': 'يرجى تسجيل الدخول مرة أخرى للمتابعة.',
  'common.signInAgain': 'تسجيل الدخول مجدداً',

  // ---- statuses ----------------------------------------------------------
  'status.active': 'نشط',
  'status.restricted': 'مقيّد',
  'status.judgment': 'حكم',
  'status.execution': 'تنفيذ',
  'status.closed': 'مغلق',
  'status.draft': 'مسودة',
  'status.pending': 'قيد الانتظار',
  'status.onHold': 'معلّق',
  'status.archived': 'مؤرشف',

  // ---- access levels (§17) ----------------------------------------------
  'access.full': 'صلاحية كاملة',
  'access.edit': 'تحرير',
  'access.operational': 'تشغيلي',
  'access.view': 'اطلاع فقط',
  'access.financial': 'مالي',
  'access.compliance': 'امتثال',

  // ---- profile / security ------------------------------------------------
  'profile.title': 'الملف الشخصي',
  'profile.role': 'الدور',
  'profile.department': 'القسم',
  'profile.practiceAreas': 'مجالات الممارسة',
  'profile.firmWide': 'نطاق المكتب بالكامل',
  'profile.authority': 'صلاحيات الاعتماد',
  'profile.authorityFinancial': 'سقف الاعتماد المالي',
  'profile.authorityWriteoff': 'سقف الإعفاء',
  'profile.authorityDiscount': 'سقف الخصم',
  'profile.noAuthority': 'لا تملك صلاحية اعتماد مالي',
  'profile.mfa': 'التحقق الثنائي',
  'profile.mfaEnabled': 'مفعّل',
  'profile.mfaDisabled': 'غير مفعّل',
  'profile.sessions': 'الجلسات النشطة',
  'profile.revokeAll': 'إنهاء جميع الجلسات',

  'tenants.switch': 'تبديل الكيان',
  'tenants.current': 'الكيان الحالي',

  // ---- preloader (§32-§33) ----------------------------------------------
  'boot.loading': 'جارٍ تحميل مساحة العمل الآمنة…',
} as const;

const en = {
  'app.name': 'KGM LEGAL OS',
  'app.tagline': 'Secure workspace',
  'app.shortName': 'KGM',

  'nav.section.main': 'Main',
  'nav.section.legal': 'Legal',
  'nav.section.business': 'Business',
  'nav.section.governance': 'Governance',

  'nav.dashboard': 'Dashboard',
  'nav.workspace': 'Workspace',
  'nav.myWork': 'My Work',
  'nav.tasks': 'Tasks',
  'nav.calendar': 'Calendar',
  'nav.notifications': 'Notifications',
  'nav.clients': 'Clients',
  'nav.matters': 'Matters',
  'nav.legal': 'Legal',
  'nav.hearings': 'Hearings',
  'nav.deadlines': 'Deadlines',
  'nav.documents': 'Documents',
  'nav.contracts': 'Contracts',
  'nav.poa': 'POA',
  'nav.finance': 'Finance',
  'nav.time': 'Time',
  'nav.expenses': 'Expenses',
  'nav.billing': 'Billing',
  'nav.collections': 'Collections',
  'nav.compliance': 'Compliance',
  'nav.conflicts': 'Conflicts',
  'nav.licences': 'Licences',
  'nav.training': 'Training',
  'nav.complaints': 'Complaints',
  'nav.communication': 'Communication',
  'nav.messages': 'Messages',
  'nav.admin': 'Administration',
  'nav.users': 'Users',
  'nav.teams': 'Teams',
  'nav.settings': 'Settings',
  'nav.audit': 'Audit',

  'nav.planned': 'In development',
  'nav.collapse': 'Collapse sidebar',
  'nav.expand': 'Expand sidebar',
  'nav.noModules': 'No modules available for your account',
  'nav.noModulesHint': 'Ask a system administrator to grant the permissions you need.',

  'topbar.search': 'Search clients, matters, documents…',
  'topbar.searchShort': 'Search',
  'topbar.commandPalette': 'Command palette',
  'topbar.notifications': 'Notifications',
  'topbar.language': 'Language',
  'topbar.theme': 'Theme',
  'topbar.help': 'Help',
  'topbar.profile': 'Profile',
  'topbar.switchLanguage': 'العربية',
  'topbar.tenant': 'Firm',

  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'theme.system': 'System',

  'mobile.home': 'Home',
  'mobile.matters': 'Matters',
  'mobile.tasks': 'Tasks',
  'mobile.docs': 'Docs',
  'mobile.more': 'More',
  'mobile.moreTitle': 'All modules',
  'mobile.close': 'Close',
  'mobile.pullToRefresh': 'Pull to refresh',

  'auth.signInTitle': 'Staff sign in',
  'auth.signInSubtitle': 'Internal workspace — invitation only',
  'auth.email': 'Work email',
  'auth.password': 'Password',
  'auth.remember': 'Keep this session alive on this device',
  'auth.rememberHint': 'Extends the idle timeout to 12 hours instead of 30 minutes.',
  'auth.submit': 'Sign in',
  'auth.signingIn': 'Verifying…',
  'auth.signOut': 'Sign out',
  'auth.clientPortalLink': 'Client portal',
  'auth.clientPortalNote': 'This workspace is for firm staff only.',

  'auth.mfaTitle': 'Two-factor verification',
  'auth.mfaSubtitle': 'Enter the code from your authenticator app',
  'auth.mfaCode': 'Verification code',
  'auth.mfaVerify': 'Verify',
  'auth.mfaDest': 'Destination',
  'auth.mfaExpires': 'Expires in {n} minutes',
  'auth.mfaBack': 'Back',

  'auth.err.invalid': 'Invalid email or password',
  'auth.err.locked': 'Account temporarily locked after repeated attempts. Try again later.',
  'auth.err.noMembership': 'No active membership is linked to this account',
  'auth.err.network': 'Could not reach the server. Check your connection and retry.',
  'auth.err.generic': 'Sign in could not be completed',
  'auth.err.required': 'This field is required',
  'auth.err.emailFormat': 'Enter a valid email address',

  'auth.demoHint': 'Demo data — all accounts are synthetic',
  'auth.demoPartner': 'Managing Partner',
  'auth.demoLawyer': 'Senior Associate',
  'auth.demoParalegal': 'Paralegal',
  'auth.demoCompliance': 'Compliance',
  'auth.demoFinance': 'Finance Officer',
  'auth.demoUse': 'Use',

  'auth.securityNote': 'Every action in this workspace is logged and audited.',

  'dash.greeting.morning': 'Good morning',
  'dash.greeting.afternoon': 'Good afternoon',
  'dash.greeting.evening': 'Good evening',
  'dash.greeting.night': 'Good evening',
  'dash.subtitle': "Here's your firm's operational overview.",
  'dash.subtitleScoped': 'Overview within your permission scope.',

  'dash.activeMatters': 'Active Matters',
  'dash.pendingHearings': 'Pending Hearings',
  'dash.outstanding': 'Outstanding',
  'dash.overdue': 'Overdue',
  'dash.deadlinesThisWeek': 'Deadlines this week',
  'dash.documentsPending': 'Documents pending approval',
  'dash.utilization': 'Utilization',
  'dash.newClients': 'New clients',

  'dash.trend.thisMonth': 'this month',
  'dash.trend.vsLastMonth': 'vs last month',
  'dash.trend.up': 'up {pct}',
  'dash.trend.down': 'down {pct}',
  'dash.trend.flat': 'no change',

  'dash.yourMatters': 'Your matters',
  'dash.yourMattersHint': 'Matters assigned to you',
  'dash.recentActivity': 'Recent activity',
  'dash.upcomingDeadlines': 'Upcoming deadlines',
  'dash.attention': 'Needs attention',
  'dash.viewAll': 'View all',
  'dash.noMetrics': 'No metrics available within your permissions',

  'dash.scopeNotice': 'This dashboard shows only the data within your practice scope and permissions.',

  'matter.title': 'Matters',
  'matter.count': '{n} matters',
  'matter.countOne': '1 matter',
  'matter.search': 'Search by matter number, title or client',
  'matter.filters': 'Filters',
  'matter.filter.status': 'Status',
  'matter.filter.practiceArea': 'Practice area',
  'matter.filter.access': 'Access level',
  'matter.filter.restricted': 'Restricted only',
  'matter.filter.clear': 'Clear filters',
  'matter.sort.newest': 'Newest',
  'matter.sort.oldest': 'Oldest',
  'matter.sort.number': 'Matter number',

  'matter.client': 'Client',
  'matter.caseNumber': 'Case number',
  'matter.matterNumber': 'Matter number',
  'matter.status': 'Status',
  'matter.practiceArea': 'Practice area',
  'matter.leadLawyer': 'Lead lawyer',
  'matter.nextHearing': 'Next hearing',
  'matter.deadline': 'Deadline',
  'matter.priority': 'Priority',
  'matter.openedAt': 'Opened',
  'matter.court': 'Court',
  'matter.teamRole': 'Your role on this matter',
  'matter.department': 'Department',
  'matter.accessLevel': 'Your access level',

  'matter.restricted': 'Restricted matter',
  'matter.restrictedNote': 'Access to this matter is by explicit grant only.',
  'matter.restrictionReason': 'Restriction reason',

  'matter.empty.title': 'No matters',
  'matter.empty.body': 'No matters are assigned to you within your current practice scope.',
  'matter.emptyFiltered.title': 'No results',
  'matter.emptyFiltered.body': 'No matter matches the filters you set.',

  'matter.denied.title': 'You cannot view this matter',
  'matter.denied.body': 'This matter is not available under your permissions, or it does not exist.',

  'matter.error.title': 'Could not load the matter',
  'matter.error.body': 'Something went wrong while fetching the data.',
  'matter.retry': 'Retry',

  'tab.overview': 'Overview',
  'tab.timeline': 'Timeline',
  'tab.team': 'Team',
  'tab.documents': 'Documents',
  'tab.hearings': 'Hearings',
  'tab.deadlines': 'Deadlines',
  'tab.contracts': 'Contracts',
  'tab.poa': 'POA',
  'tab.time': 'Time',
  'tab.expenses': 'Expenses',
  'tab.billing': 'Billing',
  'tab.messages': 'Messages',
  'tab.compliance': 'Compliance',

  'cls.withheld': 'Classified field',
  'cls.withheldHint': 'This field is classified and is not visible at your access level on this matter.',
  'cls.withheldCount': '{n} field(s) withheld by classification',
  'cls.accessExplainer': 'Your access level on this matter is “{level}”, which determines the fields you can see.',
  'cls.internalNotes': 'Internal notes',
  'cls.riskRating': 'Risk rating',
  'cls.conflictCleared': 'Conflict cleared',
  'cls.summary': 'Summary',
  'cls.internalStatus': 'Internal status',

  'timeline.title': 'Timeline',
  'timeline.empty': 'No events recorded yet.',
  'timeline.today': 'Today',

  'alert.info': 'Info',
  'alert.notice': 'Notice',
  'alert.warning': 'Warning',
  'alert.high': 'High',
  'alert.critical': 'Critical',
  'alert.deadlineApproaching': 'Deadline approaching',
  'alert.mattersNeedAttention': '{n} matters require attention today.',

  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.search': 'Search',
  'common.filter': 'Filter',
  'common.sort': 'Sort',
  'common.export': 'Export',
  'common.columns': 'Columns',
  'common.savedViews': 'Saved views',
  'common.bulkActions': 'Bulk actions',
  'common.selected': '{n} selected',
  'common.refresh': 'Refresh',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.previous': 'Previous',
  'common.page': 'Page {p} of {t}',
  'common.rows': '{from}–{to} of {total}',
  'common.none': '—',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.all': 'All',
  'common.optional': 'Optional',
  'common.required': 'Required',
  'common.copy': 'Copy',
  'common.copied': 'Copied',

  'common.error.title': 'Something went wrong',
  'common.error.body': 'This action could not be completed.',
  'common.error.network': 'Could not reach the server',
  'common.denied.title': 'Not authorized',
  'common.denied.body': 'This request was refused under the firm’s permission policy.',
  'common.notFound.title': 'Not available',
  'common.notFound.body': 'The page you asked for is not available.',

  'common.sessionExpired': 'Session expired',
  'common.sessionExpiredBody': 'Please sign in again to continue.',
  'common.signInAgain': 'Sign in again',

  'status.active': 'Active',
  'status.restricted': 'Restricted',
  'status.judgment': 'Judgment',
  'status.execution': 'Execution',
  'status.closed': 'Closed',
  'status.draft': 'Draft',
  'status.pending': 'Pending',
  'status.onHold': 'On hold',
  'status.archived': 'Archived',

  'access.full': 'Full access',
  'access.edit': 'Edit',
  'access.operational': 'Operational',
  'access.view': 'View only',
  'access.financial': 'Financial',
  'access.compliance': 'Compliance',

  'profile.title': 'Profile',
  'profile.role': 'Role',
  'profile.department': 'Department',
  'profile.practiceAreas': 'Practice areas',
  'profile.firmWide': 'Firm-wide scope',
  'profile.authority': 'Approval authority',
  'profile.authorityFinancial': 'Financial approval ceiling',
  'profile.authorityWriteoff': 'Write-off ceiling',
  'profile.authorityDiscount': 'Discount ceiling',
  'profile.noAuthority': 'You hold no financial approval authority',
  'profile.mfa': 'Two-factor authentication',
  'profile.mfaEnabled': 'Enabled',
  'profile.mfaDisabled': 'Not enabled',
  'profile.sessions': 'Active sessions',
  'profile.revokeAll': 'Revoke all sessions',

  'tenants.switch': 'Switch firm',
  'tenants.current': 'Current firm',

  'boot.loading': 'Loading secure workspace…',
} as const;

/**
 * The bundle.
 *
 * Typed as `Record<string,string>` at the boundary so the i18n runtime does not
 * depend on this file's literal types — but `ar` is the key set of record, and
 * `en` is checked against it below.
 */
export const FIRM_I18N: I18nBundle = {
  ar: ar as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

export type FirmI18nKey = keyof typeof ar;

/**
 * Compile-time-ish parity check.
 *
 * A missing English string silently renders the KEY in the UI (the runtime's
 * documented fallback), which looks like a bug rather than a translation gap and
 * is easy to miss in review. This surfaces the gap in dev at import time.
 *
 * It runs only in development: shipping the comparison to production would spend
 * startup time on a check whose result cannot change at runtime.
 */
if (import.meta.env?.DEV) {
  const arKeys = Object.keys(ar);
  const enKeys = new Set(Object.keys(en));
  const missingEn = arKeys.filter((k) => !enKeys.has(k));
  const extraEn = [...enKeys].filter((k) => !(k in ar));
  if (missingEn.length) {
    console.warn(`[firm-i18n] ${missingEn.length} key(s) missing from English:`, missingEn.slice(0, 12));
  }
  if (extraEn.length) {
    console.warn(`[firm-i18n] ${extraEn.length} English key(s) not in Arabic:`, extraEn.slice(0, 12));
  }
}

/** Keys the Arabic source of truth defines. Useful for typed lookups. */
export const FIRM_I18N_KEYS = Object.keys(ar) as FirmI18nKey[];
