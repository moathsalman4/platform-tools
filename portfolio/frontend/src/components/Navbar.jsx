import { Link } from 'react-router-dom';

function Navbar() {
  return (
    <nav className="bg-gray-900 text-white p-4">
      <div className="max-w-5xl mx-auto flex gap-6">
        <Link to="/" className="font-bold">Moath Salman</Link>
        <Link to="/projects" className="hover:text-blue-400">Projects</Link>
        <Link to="/experience" className="hover:text-blue-400">Experience</Link>
      </div>
    </nav>
  );
}

export default Navbar;