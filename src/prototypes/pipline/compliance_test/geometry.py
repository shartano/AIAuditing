import numpy as np

def triangulate_rays(rays):

    # We need at least 2 different views to find an intersection
    if len(rays) < 2:
        return None 


    matrix_A = np.zeros((3, 3))
    vector_b = np.zeros(3)

    for origin, direction in rays:
        # Normalize the direction vector to length 1
        norm = np.linalg.norm(direction)
        if norm == 0: continue
        d = direction / norm
        
        # Identity matrix
        I = np.eye(3)
        
        # Projection matrix onto the plane perpendicular to the ray
        # P = I - (d * d^T)
        P_proj = I - np.outer(d, d)
        
        # Add to the running sum for Least Squares
        matrix_A += P_proj
        vector_b += P_proj @ origin

    # Solve the equation
    try:
        estimated_position = np.linalg.solve(matrix_A, vector_b)
        return estimated_position
    except np.linalg.LinAlgError:
        return None # Matrix was singular (e.g., all rays were parallel)

def calculate_distance(p1, p2):
    if p1 is None or p2 is None:
        return None
        
    return float(np.linalg.norm(p1 - p2))