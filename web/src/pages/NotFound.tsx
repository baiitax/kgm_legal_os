import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { Icon } from '../components/ui';

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="empty" style={{ paddingBlock: 64 }}>
      <div className="empty__icon">
        <Icon name="search" size={22} />
      </div>
      <h2>{t('404.title')}</h2>
      <p className="muted">{t('404.body')}</p>
      <Link className="btn btn--primary" to="/portal" style={{ marginBlockStart: 14 }}>
        <Icon name="home" size={16} />
        {t('nav.dashboard')}
      </Link>
    </div>
  );
}
