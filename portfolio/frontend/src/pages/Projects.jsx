import { useState, useEffect } from 'react';

function Projects() {
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    fetch('http://localhost:3001/api/projects')
      .then(res => res.json())
      .then(data => setProjects(data));
  }, []);

  return (
    <div className="max-w-5xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Projects</h1>
      <div className="grid gap-6">
        {projects.map(project => (
          <div key={project.id} className="border border-gray-700 rounded-lg p-6">
            <div className="flex justify-between items-start mb-2">
              <h2 className="text-xl font-bold">{project.title}</h2>
              {project.github && (
                <a href={project.github} target="_blank" rel="noreferrer"
                   className="text-blue-400 hover:underline text-sm">
                  GitHub
                </a>
              )}
            </div>
            <p className="text-gray-400 mb-4">{project.description}</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {project.techStack.map(tech => (
                <span key={tech} className="bg-blue-900 text-blue-200 px-2 py-1 rounded text-xs">
                  {tech}
                </span>
              ))}
            </div>
            <ul className="list-disc list-inside text-gray-300 text-sm space-y-1">
              {project.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Projects;