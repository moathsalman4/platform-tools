import { useState, useEffect } from 'react';

function Home() {
  const [skills, setSkills] = useState(null);

  useEffect(() => {
    fetch('/api/skills')
      .then(res => res.json())
      .then(data => setSkills(data));
  }, []);

  return (
    <div className="max-w-5xl mx-auto p-8">
      <h1 className="text-4xl font-bold mb-2">Moath Salman</h1>
      <p className="text-xl text-gray-400 mb-4">Platform / DevOps Engineer</p>
      <div className="flex gap-4 mb-8">
        <a href="https://www.linkedin.com/in/moath-salman1a"
           target="_blank" rel="noreferrer"
           className="text-blue-400 hover:underline">
          LinkedIn
        </a>
        <a href="https://github.com/moathsalman4"
           target="_blank" rel="noreferrer"
           className="text-blue-400 hover:underline">
          GitHub
        </a>
      </div>

      {skills && (
        <div>
          <h2 className="text-2xl font-bold mb-4">Skills</h2>
          {skills.categories.map(cat => (
            <div key={cat.name} className="mb-4">
              <h3 className="font-bold text-lg">{cat.name}</h3>
              <div className="flex flex-wrap gap-2 mt-1">
                {cat.skills.map(skill => (
                  <span key={skill} className="bg-gray-800 text-gray-200 px-3 py-1 rounded-full text-sm">
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          ))}

          {skills.certifications && (
            <div className="mt-6">
              <h2 className="text-2xl font-bold mb-4">Certifications</h2>
              {skills.certifications.map(cert => (
                <div key={cert.name} className="mb-2">
                  <span className="font-bold">{cert.name}</span>
                  <span className="text-gray-400 ml-2">— {cert.issuer}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Home;