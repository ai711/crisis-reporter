import { useParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Header from '../components/Header';

export default function ProjectDetailPage() {
  const { serialId } = useParams<{ serialId: string }>();
  return (
    <Layout>
      <Header title={serialId || 'Project'} />
      <div style={{ padding: 32 }}>
        <p>Project detail page — building in Part 3.</p>
      </div>
    </Layout>
  );
}
